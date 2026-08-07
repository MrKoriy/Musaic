import { getDb } from "../db/index.js";
import { getArtistTags, getLastfmKey, getTrackTags } from "../providers/lastfm.js";
import { canonicalizeTag, tagWeight } from "../reco/tags.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTagBackfillJob(): Promise<{ processed: number; tagged: number }> {
  if (!getLastfmKey()) return { processed: 0, tagged: 0 };
  const db = getDb();
  const limit = Math.max(1, Math.min(Number(process.env.RECO_TAG_BACKFILL_LIMIT ?? 1800), 5000));
  const rows = db.prepare(`
    SELECT t.id, t.artist, t.title
    FROM tracks t
    LEFT JOIN (
      SELECT track_id, MAX(updated_at) AS updated_at
      FROM track_tags WHERE source IN ('lastfm', 'lastfm_artist') GROUP BY track_id
    ) tags ON tags.track_id = t.id
    WHERE tags.updated_at IS NULL OR tags.updated_at < unixepoch() - 90 * 86400
    ORDER BY
      EXISTS (SELECT 1 FROM liked_tracks lt WHERE lt.track_id = t.id) DESC,
      EXISTS (SELECT 1 FROM listening_history lh WHERE lh.track_id = t.id) DESC,
      t.play_count DESC, t.updated_at DESC
    LIMIT $limit
  `).all({ $limit: limit }) as Array<{ id: string; artist: string; title: string }>;
  const upsert = db.prepare(`
    INSERT INTO track_tags (track_id, tag, weight, source, updated_at)
    VALUES ($trackId, $tag, $weight, $source, unixepoch())
    ON CONFLICT(track_id, tag, source) DO UPDATE SET
      weight = excluded.weight, updated_at = excluded.updated_at
  `);
  let tagged = 0;
  for (const row of rows) {
    let tags = await getTrackTags(row.artist, row.title, 20).catch(() => []);
    let source = "lastfm";
    if (tags.length === 0) {
      tags = await getArtistTags(row.artist, 20).catch(() => []);
      source = "lastfm_artist";
    }
    const canonical = new Map<string, number>();
    for (const item of tags) {
      const tag = canonicalizeTag(item.name);
      if (!tag) continue;
      canonical.set(tag, Math.max(canonical.get(tag) ?? 0, tagWeight(item.count) * (source === "lastfm_artist" ? 0.8 : 1)));
    }
    db.transaction(() => {
      db.prepare("DELETE FROM track_tags WHERE track_id = $trackId AND source IN ('lastfm', 'lastfm_artist')")
        .run({ $trackId: row.id });
      for (const [tag, weight] of canonical) {
        upsert.run({ $trackId: row.id, $tag: tag, $weight: weight, $source: source });
      }
    })();
    if (canonical.size > 0) tagged++;
    await sleep(2000);
  }
  return { processed: rows.length, tagged };
}
