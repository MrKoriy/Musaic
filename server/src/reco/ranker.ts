import { getDb } from "../db/index.js";
import { invalidateAllCaches } from "../utils/cache.js";

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
  baselineAuc: number;
  precisionAt5: number;
  precisionAt10: number;
  baselinePrecisionAt5: number;
  baselinePrecisionAt10: number;
  evaluationMethod: string;
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
    SELECT version, auc, baseline_auc, precision_at_5, precision_at_10,
           baseline_precision_at_5, baseline_precision_at_10, evaluation_method,
           trained_at, impressions_used, weights_json
    FROM reco_models ORDER BY trained_at DESC, id DESC LIMIT 1
  `).get() as {
    version: string;
    auc: number;
    baseline_auc: number;
    precision_at_5: number;
    precision_at_10: number;
    baseline_precision_at_5: number;
    baseline_precision_at_10: number;
    evaluation_method: string;
    trained_at: number;
    impressions_used: number;
    weights_json: string;
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
      baselineAuc: Number(row.baseline_auc ?? 0),
      precisionAt5: Number(row.precision_at_5 ?? 0),
      precisionAt10: Number(row.precision_at_10 ?? 0),
      baselinePrecisionAt5: Number(row.baseline_precision_at_5 ?? 0),
      baselinePrecisionAt10: Number(row.baseline_precision_at_10 ?? 0),
      evaluationMethod: row.evaluation_method ?? "legacy",
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
  requestId: string;
  trackId: string;
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

function scoreWithPayload(payload: RecoModelPayload, row: TrainingRow): number {
  const standardized = row.features.map((value, index) =>
    (value - (payload.means[index] ?? 0)) / (payload.scales[index] || 1)
  );
  return sigmoid(payload.bias + standardized.reduce(
    (sum, value, index) => sum + value * (payload.weights[index] ?? 0),
    0,
  ));
}

function hasBothLabels(rows: TrainingRow[]): boolean {
  return new Set(rows.map((row) => row.label)).size > 1;
}

interface EvaluationResult {
  rows: TrainingRow[];
  scores: number[];
  method: string;
}

/** Build deterministic, label-balanced folds without using the test fold to fit. */
function stratifiedFolds(rows: TrainingRow[], foldCount: number): TrainingRow[][] {
  const folds = Array.from({ length: foldCount }, () => [] as TrainingRow[]);
  const byLabel = new Map<number, TrainingRow[]>();
  for (const row of rows) {
    const bucket = byLabel.get(row.label) ?? [];
    bucket.push(row);
    byLabel.set(row.label, bucket);
  }
  for (const bucket of byLabel.values()) {
    bucket.sort((left, right) => left.createdAt - right.createdAt || left.trackId.localeCompare(right.trackId));
    bucket.forEach((row, index) => folds[index % foldCount]!.push(row));
  }
  return folds;
}

function evaluateModel(rows: TrainingRow[]): EvaluationResult {
  const ordered = [...rows].sort((left, right) => left.createdAt - right.createdAt);
  const split = Math.max(1, Math.floor(ordered.length * 0.8));
  const trainRows = ordered.slice(0, split);
  const holdoutRows = ordered.slice(split);

  // A temporal holdout is preferred when it has enough observations and both
  // classes. It never evaluates on rows used to fit the returned payload.
  if (holdoutRows.length >= 20 && hasBothLabels(trainRows) && hasBothLabels(holdoutRows)) {
    const { payload } = train(trainRows);
    return {
      rows: holdoutRows,
      scores: holdoutRows.map((row) => scoreWithPayload(payload, row)),
      method: "temporal-holdout",
    };
  }

  // Small holdouts are common during early rollout. Use honest stratified CV
  // rather than the old in-sample constant-bias fallback.
  const folds = stratifiedFolds(ordered, 5);
  const evaluationRows: TrainingRow[] = [];
  const scores: number[] = [];
  for (const fold of folds) {
    if (fold.length === 0) continue;
    const testSet = new Set(fold);
    const fitRows = ordered.filter((row) => !testSet.has(row));
    if (fitRows.length === 0) continue;
    const { payload } = train(fitRows);
    evaluationRows.push(...fold);
    scores.push(...fold.map((row) => scoreWithPayload(payload, row)));
  }
  return { rows: evaluationRows, scores, method: "stratified-5-fold-cv" };
}

function precisionAtK(rows: TrainingRow[], scores: number[], k: number): number {
  const byRequest = new Map<string, Array<{ row: TrainingRow; score: number }>>();
  rows.forEach((row, index) => {
    const group = byRequest.get(row.requestId) ?? [];
    group.push({ row, score: scores[index] ?? 0 });
    byRequest.set(row.requestId, group);
  });
  if (byRequest.size === 0) return 0;

  let total = 0;
  for (const group of byRequest.values()) {
    const top = [...group].sort((left, right) => right.score - left.score).slice(0, k);
    if (top.length === 0) continue;
    total += top.filter((item) => item.row.label === 1).length / top.length;
  }
  return total / byRequest.size;
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
  const grouped = new Map<string, {
    requestId: string;
    trackId: string;
    features: number[];
    createdAt: number;
    label: number | null;
  }>();
  for (const row of rows) {
    const key = JSON.stringify([row.request_id, row.track_id]);
    let features: number[];
    try {
      const parsed = JSON.parse(row.features_json) as unknown;
      if (!Array.isArray(parsed) || parsed.length < RECO_FEATURE_NAMES.length) continue;
      features = RECO_FEATURE_NAMES.map((_, index) => {
        const value = Number(parsed[index]);
        return Number.isFinite(value) ? value : 0;
      });
    } catch {
      continue;
    }
    const existing = grouped.get(key) ?? {
      requestId: row.request_id,
      trackId: row.track_id,
      features,
      createdAt: Number(row.created_at),
      label: null,
    };
    if (row.action === "like" || row.action === "complete" || (row.played_ratio != null && row.played_ratio >= 0.5)) existing.label = 1;
    else if (existing.label !== 1 && row.action === "skip" && (row.played_ratio ?? 0) < 0.25) existing.label = 0;
    grouped.set(key, existing);
  }
  const trainingRows = [...grouped.values()]
    .filter((row): row is typeof row & { label: number } => row.label != null)
    .map((row) => ({ ...row, label: row.label }));
  const minimumSamples = 50;
  if (trainingRows.length < minimumSamples) {
    console.log(`[reco-ranker] skip training, too few samples (${trainingRows.length}/${minimumSamples})`);
    return null;
  }
  if (!hasBothLabels(trainingRows)) {
    console.log("[reco-ranker] skip training, labels contain only one class");
    return null;
  }

  const evaluation = evaluateModel(trainingRows);
  if (evaluation.rows.length === 0) {
    console.log("[reco-ranker] skip training, no honest evaluation rows");
    return null;
  }
  const evaluationLabels = evaluation.rows.map((row) => row.label);
  const auc = aucScore(evaluationLabels, evaluation.scores);
  const baselineScores = evaluation.rows.map((row) => row.features[0] ?? 0);
  const baselineAuc = aucScore(evaluationLabels, baselineScores);
  const { payload } = train(trainingRows);
  const version = `lr-${Date.now()}`;
  db.prepare(`
    INSERT INTO reco_models (
      version, trained_at, impressions_used, auc, baseline_auc,
      precision_at_5, precision_at_10, baseline_precision_at_5,
      baseline_precision_at_10, evaluation_method, weights_json
    ) VALUES (
      $version, unixepoch(), $count, $auc, $baselineAuc,
      $precisionAt5, $precisionAt10, $baselinePrecisionAt5,
      $baselinePrecisionAt10, $evaluationMethod, $weights
    )
  `).run({
    $version: version,
    $count: trainingRows.length,
    $auc: auc,
    $baselineAuc: baselineAuc,
    $precisionAt5: precisionAtK(evaluation.rows, evaluation.scores, 5),
    $precisionAt10: precisionAtK(evaluation.rows, evaluation.scores, 10),
    $baselinePrecisionAt5: precisionAtK(evaluation.rows, baselineScores, 5),
    $baselinePrecisionAt10: precisionAtK(evaluation.rows, baselineScores, 10),
    $evaluationMethod: evaluation.method,
    $weights: JSON.stringify(payload),
  });
  clearRecoModelCache();
  invalidateAllCaches();
  return {
    version,
    auc,
    baselineAuc,
    precisionAt5: precisionAtK(evaluation.rows, evaluation.scores, 5),
    precisionAt10: precisionAtK(evaluation.rows, evaluation.scores, 10),
    baselinePrecisionAt5: precisionAtK(evaluation.rows, baselineScores, 5),
    baselinePrecisionAt10: precisionAtK(evaluation.rows, baselineScores, 10),
    evaluationMethod: evaluation.method,
    trainedAt: Math.floor(Date.now() / 1000),
    impressionsUsed: trainingRows.length,
    payload,
  };
}
