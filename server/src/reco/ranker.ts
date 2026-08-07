import { getDb } from "../db/index.js";

export const RECO_FEATURE_NAMES = [
  "handScore",
  "baseScore",
  "signalCount",
  "artistPositiveCount",
  "artistEarlySkipRate",
  "tagOverlap",
  "cfSimilarity",
  "familiar",
  "logHoursSincePlay",
  "hoursSinceSkip",
  "sourceScore",
  "variantPenalty",
  "moodMatchCount",
  "seedArtistOverlap",
  "logPlayCount",
] as const;

export type RecoFeatureName = typeof RECO_FEATURE_NAMES[number];
export type RecoFeatureVector = Record<RecoFeatureName, number>;

export interface RecoModelPayload {
  featureNames: string[];
  means: number[];
  scales: number[];
  weights: number[];
  bias: number;
}

export interface StoredRecoModel {
  version: string;
  auc: number;
  trainedAt: number;
  impressionsUsed: number;
  payload: RecoModelPayload;
}

let cachedModel: { db: unknown; expiresAt: number; model: StoredRecoModel | null } | null = null;

export function vectorFromFeatures(features: RecoFeatureVector): number[] {
  return RECO_FEATURE_NAMES.map((name) => Number.isFinite(features[name]) ? features[name] : 0);
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-Math.min(value, 60));
    return 1 / (1 + z);
  }
  const z = Math.exp(Math.max(value, -60));
  return z / (1 + z);
}

export function predictRecoModel(model: StoredRecoModel, features: RecoFeatureVector): number {
  const values = vectorFromFeatures(features);
  const standardized = values.map((value, index) => (value - (model.payload.means[index] ?? 0)) / (model.payload.scales[index] || 1));
  const linear = model.payload.bias + standardized.reduce((sum, value, index) => sum + value * (model.payload.weights[index] ?? 0), 0);
  return sigmoid(linear);
}

export function clearRecoModelCache(): void {
  cachedModel = null;
}

export function loadLatestRecoModel(): StoredRecoModel | null {
  const db = getDb();
  if (cachedModel && cachedModel.db === db && cachedModel.expiresAt > Date.now()) return cachedModel.model;
  const row = db.prepare(`
    SELECT version, auc, trained_at, impressions_used, weights_json
    FROM reco_models ORDER BY trained_at DESC, id DESC LIMIT 1
  `).get() as {
    version: string; auc: number; trained_at: number; impressions_used: number; weights_json: string;
  } | null;
  if (!row) {
    cachedModel = { db, expiresAt: Date.now() + 5 * 60_000, model: null };
    return null;
  }
  try {
    const payload = JSON.parse(row.weights_json) as RecoModelPayload;
    const model: StoredRecoModel = {
      version: row.version,
      auc: Number(row.auc),
      trainedAt: Number(row.trained_at),
      impressionsUsed: Number(row.impressions_used),
      payload,
    };
    cachedModel = { db, expiresAt: Date.now() + 5 * 60_000, model };
    return model;
  } catch {
    cachedModel = { db, expiresAt: Date.now() + 5 * 60_000, model: null };
    return null;
  }
}

export function aucScore(labels: number[], scores: number[]): number {
  const positives = labels.filter((label) => label === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  const order = labels.map((label, index) => ({ label, score: scores[index] }))
    .sort((left, right) => left.score - right.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (const item of order) {
    if (item.label === 1) positiveRankSum += rank;
    rank++;
  }
  return Math.max(0, Math.min(1, (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives)));
}

interface TrainingRow {
  features: number[];
  label: number;
  createdAt: number;
}

function train(rows: TrainingRow[]): { payload: RecoModelPayload; auc: number } {
  const dimensions = RECO_FEATURE_NAMES.length;
  const means = Array.from({ length: dimensions }, (_, index) => rows.reduce((sum, row) => sum + row.features[index], 0) / rows.length);
  const scales = Array.from({ length: dimensions }, (_, index) => {
    const variance = rows.reduce((sum, row) => sum + Math.pow(row.features[index] - means[index], 2), 0) / rows.length;
    return Math.max(0.0001, Math.sqrt(variance));
  });
  const values = rows.map((row) => row.features.map((value, index) => (value - means[index]) / scales[index]));
  const weights = Array.from({ length: dimensions }, () => 0);
  let bias = 0;
  const learningRate = 0.05;
  const regularization = 1e-4;
  for (let iteration = 0; iteration < 300; iteration++) {
    const gradient = Array.from({ length: dimensions }, () => 0);
    let biasGradient = 0;
    values.forEach((row, rowIndex) => {
      const prediction = sigmoid(bias + row.reduce((sum, value, index) => sum + value * weights[index], 0));
      const error = prediction - rows[rowIndex].label;
      biasGradient += error;
      row.forEach((value, index) => { gradient[index] += error * value; });
    });
    const n = rows.length;
    bias -= learningRate * biasGradient / n;
    for (let index = 0; index < dimensions; index++) {
      weights[index] -= learningRate * (gradient[index] / n + regularization * weights[index]);
    }
  }
  const payload: RecoModelPayload = {
    featureNames: [...RECO_FEATURE_NAMES], means, scales, weights, bias,
  };
  const modelScores = values.map((row) => sigmoid(bias + row.reduce((sum, value, index) => sum + value * weights[index], 0)));
  return { payload, auc: aucScore(rows.map((row) => row.label), modelScores) };
}

export function trainRanker(): StoredRecoModel | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ri.request_id, ri.track_id, ri.created_at, ri.features_json,
           lh.action, lh.played_ratio
    FROM recommendation_impressions ri
    LEFT JOIN listening_history lh
      ON lh.request_id = ri.request_id AND lh.track_id = ri.track_id
    WHERE ri.features_json IS NOT NULL
      AND ri.created_at >= unixepoch() - 90 * 86400
    ORDER BY ri.created_at, lh.id
  `).all() as Array<{
    request_id: string; track_id: string; created_at: number; features_json: string;
    action: string | null; played_ratio: number | null;
  }>;
  const requestHasPlayback = new Set(rows.filter((row) => row.action && ["play", "complete", "skip", "like", "dislike"].includes(row.action))
    .map((row) => row.request_id));
  const grouped = new Map<string, { features: number[]; createdAt: number; label: number | null }>();
  for (const row of rows) {
    const key = `${row.request_id}:${row.track_id}`;
    const existing = grouped.get(key) ?? {
      features: JSON.parse(row.features_json) as number[], createdAt: Number(row.created_at), label: null,
    };
    if (row.action === "like" || row.action === "complete" || (row.played_ratio != null && row.played_ratio >= 0.5)) existing.label = 1;
    else if (existing.label !== 1 && row.action === "skip" && (row.played_ratio ?? 0) < 0.25) existing.label = 0;
    grouped.set(key, existing);
  }
  const trainingRows = [...grouped.values()].filter((row) => row.label != null || requestHasPlayback.size > 0)
    .flatMap((row) => row.label == null ? [] : [{ ...row, label: row.label! }]);
  if (trainingRows.length < 20 || new Set(trainingRows.map((row) => row.label)).size < 2) return null;
  trainingRows.sort((left, right) => left.createdAt - right.createdAt);
  const split = Math.max(1, Math.floor(trainingRows.length * 0.8));
  const trainRows = trainingRows.slice(0, split);
  const holdoutRows = trainingRows.slice(split);
  const { payload } = train(trainRows);
  const holdoutScores = holdoutRows.map((row) => {
    const values = row.features.map((value, index) => (value - payload.means[index]) / (payload.scales[index] || 1));
    return sigmoid(payload.bias + values.reduce((sum, value, index) => sum + value * payload.weights[index], 0));
  });
  const auc = holdoutRows.length > 1
    ? aucScore(holdoutRows.map((row) => row.label), holdoutScores)
    : aucScore(trainRows.map((row) => row.label), trainRows.map((row) => sigmoid(payload.bias)));
  const version = `lr-${Date.now()}`;
  db.prepare(`
    INSERT INTO reco_models (version, trained_at, impressions_used, auc, weights_json)
    VALUES ($version, unixepoch(), $count, $auc, $weights)
  `).run({ $version: version, $count: trainingRows.length, $auc: auc, $weights: JSON.stringify(payload) });
  clearRecoModelCache();
  return { version, auc, trainedAt: Math.floor(Date.now() / 1000), impressionsUsed: trainingRows.length, payload };
}
