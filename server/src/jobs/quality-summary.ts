import { getDb } from "../db/index.js";
import { log } from "../logger.js";

export function logRecommendationQualitySummary(days = 1): Record<string, unknown> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare(`
    SELECT surface,
      COUNT(*) AS playback_events,
      SUM(CASE WHEN action = 'skip' AND COALESCE(played_ratio, 0) < 0.2 THEN 1 ELSE 0 END) AS early_skips,
      SUM(CASE WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.5 THEN 1 ELSE 0 END) AS accepted
    FROM listening_history
    WHERE played_at >= $cutoff AND surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'discover', 'themed_station')
    GROUP BY surface
  `).all({ $cutoff: cutoff }) as Array<Record<string, string | number>>;
  const summary = Object.fromEntries(rows.map((row) => {
    const events = Number(row.playback_events ?? 0);
    return [String(row.surface), {
      playbackEvents: events,
      earlySkipRate: events > 0 ? Number(row.early_skips ?? 0) / events : 0,
      acceptedRate: events > 0 ? Number(row.accepted ?? 0) / events : 0,
    }];
  }));
  const payload = { days, generatedAt: new Date().toISOString(), surfaces: summary };
  log.info("reco-quality", JSON.stringify(payload));
  return payload;
}
