import { getDb } from "../db/index.js";
import { songFamilyKey } from "../utils/track-identity.js";
import crypto from "crypto";
import { collapseTrackVariants } from "./engine.js";

function recommendationRequestId(): string {
  return crypto.randomUUID();
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function recommendationEnvelope(
  payload: Record<string, unknown>,
  surface: string,
  userId: string | null,
  stableRequestId?: string
): Record<string, unknown> {
  const requestId = stableRequestId ?? recommendationRequestId();
  const rawTracks = Array.isArray(payload.tracks)
    ? payload.tracks.filter((track): track is Record<string, unknown> => Boolean(track && typeof track === "object"))
    : [];
  const tracks: Array<Record<string, unknown>> = collapseTrackVariants(rawTracks).map((track) => ({
    ...track,
    canonicalFamilyId: songFamilyKey({ artist: String(track.artist ?? ""), title: String(track.title ?? "") }),
  }));
  const responseTracks = tracks.map((track) => {
    const clean = { ...track };
    delete clean._recoHandScore;
    delete clean._recoModelScore;
    delete clean._recoModelVersion;
    delete clean._recoFeatures;
    delete clean.local_path;
    delete clean.localPath;
    delete clean.stream_url;
    delete clean.streamUrl;
    return clean;
  });
  const responsePayload = typeof payload.count === "number"
    ? { ...payload, tracks: responseTracks, count: responseTracks.length }
    : { ...payload, tracks: responseTracks };
  const weekKey = (() => {
    const date = new Date();
    const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return `${date.getUTCFullYear()}-${Math.ceil(((date.getTime() - start.getTime()) / 86400000 + start.getUTCDay() + 1) / 7)}`;
  })();
  const configuredVariant = process.env.RECO_VARIANT?.trim().toUpperCase();
  const variant = configuredVariant === "A" || configuredVariant === "B"
    ? configuredVariant
    : stableHash(`${userId ?? "anonymous"}:${weekKey}`) % 2 === 0 ? "A" : "B";
  const db = getDb();
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO recommendation_impressions
        (request_id, user_id, surface, track_id, position, reco_variant,
         hand_score, model_score, model_version, features_json)
      VALUES ($requestId, $userId, $surface, $trackId, $position, $variant,
              $handScore, $modelScore, $modelVersion, $features)
    `);
    tracks.forEach((track, position) => {
      if (!track || typeof track !== "object") return;
      const trackId = String((track as Record<string, unknown>).id ?? "").trim();
      if (!trackId) return;
      insert.run({
        $requestId: requestId,
        $userId: userId,
        $surface: surface,
        $trackId: trackId,
        $position: position,
        $variant: variant,
        $handScore: typeof track._recoHandScore === "number" ? track._recoHandScore : null,
        $modelScore: typeof track._recoModelScore === "number" ? track._recoModelScore : null,
        $modelVersion: typeof track._recoModelVersion === "string" ? track._recoModelVersion : null,
        $features: Array.isArray(track._recoFeatures) ? JSON.stringify(track._recoFeatures) : null,
      });
    });
  })();
  return { ...responsePayload, requestId, recoVariant: variant };
}

export const DAILY_MIX_ALGORITHM_VERSION = "daily-mix-v1";
const DAILY_MIX_THEME_ID = "default";

export interface DailyMixSnapshotRow {
  id: string;
  request_id: string;
  name: string;
  source: string;
  revision: number;
  local_date: string;
  theme_id: string;
  theme_name: string;
}

function datePartsInTimeZone(date: Date, timeZone: string): { dateKey: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { dateKey: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) || 0 };
}

export function dailyMixDateContext(rawTimeZone?: string, rawLocalDate?: string): { dateKey: string; hour: number; timeZone: string } {
  let timeZone = "UTC";
  const candidate = rawTimeZone?.trim();
  if (candidate && candidate.length <= 64) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
      timeZone = candidate;
    } catch { /* explicit UTC fallback */ }
  }
  const context = datePartsInTimeZone(new Date(), timeZone);
  if (rawLocalDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawLocalDate)) return { ...context, timeZone };
  return { ...context, timeZone };
}

export function dailyMixName(hour: number): string {
  return hour < 12 ? "Morning Mix" : hour < 18 ? "Afternoon Mix" : hour < 22 ? "Evening Mix" : "Late Night Mix";
}

export function loadDailyMixSnapshot(userKey: string, dateKey: string): (DailyMixSnapshotRow & { tracks: Record<string, unknown>[] }) | null {
  const db = getDb();
  const snapshot = db.prepare(`
    SELECT id, request_id, name, source, revision, local_date, theme_id, theme_name
    FROM daily_mix_snapshots
    WHERE user_key = $userKey AND local_date = $dateKey
      AND algorithm_version = $algorithmVersion AND theme_id = $themeId
    ORDER BY revision DESC LIMIT 1
  `).get({
    $userKey: userKey, $dateKey: dateKey, $algorithmVersion: DAILY_MIX_ALGORITHM_VERSION, $themeId: DAILY_MIX_THEME_ID,
  }) as DailyMixSnapshotRow | null;
  if (!snapshot) return null;
  const items = db.prepare(`
    SELECT payload_json FROM daily_mix_snapshot_items
    WHERE snapshot_id = $snapshotId ORDER BY position
  `).all({ $snapshotId: snapshot.id }) as Array<{ payload_json: string }>;
  return { ...snapshot, tracks: items.map((item) => JSON.parse(item.payload_json) as Record<string, unknown>) };
}

export function saveDailyMixSnapshot(options: {
  userId: string | null;
  userKey: string;
  dateKey: string;
  name: string;
  tracks: Record<string, unknown>[];
}): DailyMixSnapshotRow & { tracks: Record<string, unknown>[] } {
  const db = getDb();
  return db.transaction(() => {
    const latest = db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision FROM daily_mix_snapshots
      WHERE user_key = $userKey AND local_date = $dateKey
        AND algorithm_version = $algorithmVersion AND theme_id = $themeId
    `).get({
      $userKey: options.userKey, $dateKey: options.dateKey, $algorithmVersion: DAILY_MIX_ALGORITHM_VERSION, $themeId: DAILY_MIX_THEME_ID,
    }) as { revision: number };
    const snapshotId = crypto.randomUUID();
    const requestId = recommendationRequestId();
    const revision = Number(latest.revision) + 1;
    db.prepare(`
      INSERT INTO daily_mix_snapshots
        (id, user_key, user_id, local_date, algorithm_version, theme_id, theme_name,
         revision, request_id, name, source)
      VALUES ($id, $userKey, $userId, $dateKey, $algorithmVersion, $themeId, $themeName,
              $revision, $requestId, $name, 'daily_mix')
    `).run({
      $id: snapshotId, $userKey: options.userKey, $userId: options.userId, $dateKey: options.dateKey,
      $algorithmVersion: DAILY_MIX_ALGORITHM_VERSION, $themeId: DAILY_MIX_THEME_ID, $themeName: "Daily Mix",
      $revision: revision, $requestId: requestId, $name: options.name,
    });
    const insertItem = db.prepare(`
      INSERT INTO daily_mix_snapshot_items
        (snapshot_id, track_id, canonical_key, position, score, reason, payload_json)
      VALUES ($snapshotId, $trackId, $canonicalKey, $position, $score, $reason, $payload)
    `);
    options.tracks.forEach((track, position) => insertItem.run({
      $snapshotId: snapshotId,
      $trackId: String(track.id ?? ""),
      $canonicalKey: songFamilyKey({ artist: String(track.artist ?? ""), title: String(track.title ?? "") }),
      $position: position,
      $score: typeof track.score === "number" ? track.score : null,
      $reason: typeof track.reason === "string" ? track.reason : null,
      $payload: JSON.stringify(track),
    }));
    return {
      id: snapshotId, request_id: requestId, name: options.name, source: "daily_mix", revision,
      local_date: options.dateKey, theme_id: DAILY_MIX_THEME_ID, theme_name: "Daily Mix", tracks: options.tracks,
    };
  })();
}

export function dailyMixPayload(snapshot: DailyMixSnapshotRow & { tracks: Record<string, unknown>[] }): Record<string, unknown> {
  const nextDay = new Date(`${snapshot.local_date}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    name: snapshot.name, tracks: snapshot.tracks, source: snapshot.source, refreshAt: nextDay.toISOString(),
    revision: snapshot.revision, localDate: snapshot.local_date, themeId: snapshot.theme_id, themeName: snapshot.theme_name,
  };
}

export function getRecommendationQuality(options: {
  userId: string | null;
  days?: string;
  variant?: string;
}): Record<string, unknown> {
  const requestedDays = Number(options.days ?? 30);
  const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(Math.floor(requestedDays), 365)) : 30;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const requestedVariant = options.variant?.trim().toUpperCase();
  const variant = requestedVariant === "A" || requestedVariant === "B" ? requestedVariant : null;
  const variantHistoryFilter = variant
    ? "AND request_id IN (SELECT request_id FROM recommendation_impressions WHERE reco_variant = $variant AND created_at >= $cutoff)"
    : "";
  const variantImpressionFilter = variant ? "AND ri.reco_variant = $variant" : "";
  const variantParams: { $variant: string | null } = { $variant: variant };
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(CASE WHEN action IN ('play', 'complete', 'skip') THEN 1 END) AS playback_events,
      COUNT(CASE WHEN action = 'skip' AND COALESCE(played_ratio, 0) < 0.2 THEN 1 END) AS early_skips,
      COUNT(CASE WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.8 THEN 1 END) AS long_listens,
      COUNT(CASE WHEN action = 'like' THEN 1 END) AS likes,
      COUNT(DISTINCT CASE
        WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.5 THEN track_id
        ELSE NULL END) AS accepted_tracks,
      COUNT(DISTINCT CASE
        WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.5 THEN session_id
        ELSE NULL END) AS sessions,
      COUNT(DISTINCT CASE
        WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.5 THEN request_id
        ELSE NULL END) AS accepted_requests
    FROM listening_history
      WHERE played_at >= $cutoff
      AND surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'themed_station')
      ${variantHistoryFilter}
      AND (user_id = $userId OR (user_id IS NULL AND $userId IS NULL))
  `).get({ $cutoff: cutoff, $userId: options.userId, ...variantParams }) as {
    playback_events: number;
    early_skips: number;
    long_listens: number;
    likes: number;
    accepted_tracks: number;
    sessions: number;
    accepted_requests: number;
  };
  const impressions = db.prepare(`
    SELECT COUNT(*) AS impressions, COUNT(DISTINCT request_id) AS requests
    FROM recommendation_impressions
      WHERE created_at >= $cutoff
      AND surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'discover', 'themed_station')
      ${variant ? "AND reco_variant = $variant" : ""}
      AND (user_id = $userId OR (user_id IS NULL AND $userId IS NULL))
  `).get({ $cutoff: cutoff, $userId: options.userId, ...variantParams }) as { impressions: number; requests: number };
  const breakdown = db.prepare(`
    SELECT ri.surface, COALESCE(t.source, 'unknown') AS provider,
      CASE WHEN ri.position < 5 THEN '0-4' WHEN ri.position < 10 THEN '5-9' ELSE '10+' END AS position,
      COUNT(*) AS delivered,
      COUNT(DISTINCT CASE WHEN lh.action IN ('play', 'complete') THEN ri.request_id || ':' || ri.track_id END) AS played,
      COUNT(DISTINCT CASE WHEN lh.action = 'like' OR lh.action = 'complete' OR COALESCE(lh.played_ratio, 0) >= 0.5
        THEN ri.request_id || ':' || ri.track_id END) AS accepted
    FROM recommendation_impressions ri
    LEFT JOIN tracks t ON t.id = ri.track_id
    LEFT JOIN listening_history lh ON lh.request_id = ri.request_id AND lh.track_id = ri.track_id
      WHERE ri.created_at >= $cutoff
      AND ri.surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'discover', 'themed_station')
      ${variantImpressionFilter}
      AND (ri.user_id = $userId OR (ri.user_id IS NULL AND $userId IS NULL))
      GROUP BY ri.surface, provider,
        CASE WHEN ri.position < 5 THEN '0-4' WHEN ri.position < 10 THEN '5-9' ELSE '10+' END
  `).all({ $cutoff: cutoff, $userId: options.userId, ...variantParams }) as Array<Record<string, string | number>>;
  const positionRows = db.prepare(`
    SELECT ri.position,
      COUNT(*) AS delivered,
      COUNT(DISTINCT CASE WHEN lh.action = 'skip' AND COALESCE(lh.played_ratio, 0) < 0.2
        THEN ri.request_id || ':' || ri.track_id END) AS early_skips,
      COUNT(DISTINCT CASE WHEN lh.action = 'like' OR lh.action = 'complete' OR COALESCE(lh.played_ratio, 0) >= 0.5
        THEN ri.request_id || ':' || ri.track_id END) AS accepted
    FROM recommendation_impressions ri
    LEFT JOIN listening_history lh ON lh.request_id = ri.request_id AND lh.track_id = ri.track_id
    WHERE ri.created_at >= $cutoff
      AND ri.surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'discover', 'themed_station')
      ${variantImpressionFilter}
      AND (ri.user_id = $userId OR (ri.user_id IS NULL AND $userId IS NULL))
    GROUP BY ri.position ORDER BY ri.position
  `).all({ $cutoff: cutoff, $userId: options.userId, ...variantParams }) as Array<Record<string, string | number>>;
  const familyCounts = new Map<string, number>();
  const deliveredRows = db.prepare(`
      SELECT t.artist, t.title FROM recommendation_impressions ri
      JOIN tracks t ON t.id = ri.track_id
      WHERE ri.created_at >= $cutoff
        AND ri.surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'discover', 'themed_station')
        ${variantImpressionFilter}
        AND (ri.user_id = $userId OR (ri.user_id IS NULL AND $userId IS NULL))
  `).all({ $cutoff: cutoff, $userId: options.userId, ...variantParams }) as Array<{ artist: string; title: string }>;
  for (const track of deliveredRows) {
    const family = songFamilyKey(track);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }
  const playbackEvents = Number(row.playback_events ?? 0);
  const requestCount = Number(impressions.requests ?? 0);
  const impressionCount = Number(impressions.impressions ?? 0);
  const repeated = [...familyCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const newArtist = db.prepare(`
    SELECT COUNT(DISTINCT CASE WHEN (lh.action = 'like' OR lh.action = 'complete' OR COALESCE(lh.played_ratio, 0) >= 0.5)
      AND NOT EXISTS (
      SELECT 1 FROM listening_history prior
      JOIN tracks prior_track ON prior_track.id = prior.track_id
      WHERE prior.user_id = ri.user_id AND lower(prior_track.artist) = lower(t.artist)
        AND (prior.action = 'complete' OR COALESCE(prior.played_ratio, 0) >= 0.5)
        AND prior.played_at < ri.created_at
    ) THEN t.artist END) AS new_artists,
    COUNT(DISTINCT CASE WHEN lh.action = 'like' OR lh.action = 'complete' OR COALESCE(lh.played_ratio, 0) >= 0.5
      THEN ri.request_id || ':' || ri.track_id END) AS accepted
    FROM recommendation_impressions ri
    JOIN tracks t ON t.id = ri.track_id
    LEFT JOIN listening_history lh ON lh.request_id = ri.request_id AND lh.track_id = ri.track_id
    WHERE ri.created_at >= $cutoff
      AND ri.surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'discover', 'themed_station')
      ${variantImpressionFilter}
      AND (ri.user_id = $userId OR (ri.user_id IS NULL AND $userId IS NULL))
  `).get({ $cutoff: cutoff, $userId: options.userId, ...variantParams }) as { new_artists: number; accepted: number };
  const sessionLength = db.prepare(`
    SELECT AVG(events) AS average_events, AVG(duration) AS average_seconds
    FROM (
      SELECT session_id, COUNT(*) AS events, MAX(played_at) - MIN(played_at) AS duration
      FROM listening_history
      WHERE played_at >= $cutoff AND surface = 'my_vibe' AND session_id IS NOT NULL
        ${variantHistoryFilter}
        AND (user_id = $userId OR (user_id IS NULL AND $userId IS NULL))
      GROUP BY session_id
    )
  `).get({ $cutoff: cutoff, $userId: options.userId, ...variantParams }) as { average_events: number | null; average_seconds: number | null };

  return {
    days,
    impressions: impressionCount,
    requests: requestCount,
    playbackEvents,
    earlySkipRate: playbackEvents > 0 ? Number(row.early_skips ?? 0) / playbackEvents : 0,
    longListenRate: playbackEvents > 0 ? Number(row.long_listens ?? 0) / playbackEvents : 0,
    likes: Number(row.likes ?? 0),
    acceptedTracks: Number(row.accepted_tracks ?? 0),
    sessions: Number(row.sessions ?? 0),
    acceptedRequestRate: requestCount > 0 ? Number(row.accepted_requests ?? 0) / requestCount : 0,
    canonicalRepeatRate: impressionCount > 0 ? repeated / impressionCount : 0,
    variant,
    newArtistAcceptanceRate: Number(newArtist.accepted ?? 0) > 0
      ? Number(newArtist.new_artists ?? 0) / Number(newArtist.accepted ?? 0)
      : 0,
    newArtistsAccepted: Number(newArtist.new_artists ?? 0),
    sessionLength: {
      averageEvents: Number(sessionLength.average_events ?? 0),
      averageSeconds: Number(sessionLength.average_seconds ?? 0),
    },
    skipRateByPosition: positionRows.map((item) => ({
      position: Number(item.position),
      delivered: Number(item.delivered),
      earlySkipRate: Number(item.delivered) > 0 ? Number(item.early_skips) / Number(item.delivered) : 0,
      acceptedRate: Number(item.delivered) > 0 ? Number(item.accepted) / Number(item.delivered) : 0,
    })),
    breakdown: breakdown.map((item) => ({
      ...item,
      deliveredToPlayedRate: Number(item.delivered) > 0 ? Number(item.played) / Number(item.delivered) : 0,
      deliveredToAcceptedRate: Number(item.delivered) > 0 ? Number(item.accepted) / Number(item.delivered) : 0,
    })),
    queue: { refillEvents: null, emptyEvents: null },
  };
}
