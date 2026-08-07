import { getDb } from "../db/index.js";
import { buildWeightedProfile } from "../providers/taste-engine.js";
import { getSimilarArtists, getLastfmKey } from "../providers/lastfm.js";
import { normalizeArtistIdentity } from "../utils/track-identity.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runArtistGraphJob(userId: string | null = null): Promise<{ artists: number; edges: number }> {
  if (!getLastfmKey()) return { artists: 0, edges: 0 };
  const db = getDb();
  const profile = buildWeightedProfile(userId);
  const profileArtists = new Map(profile.topArtists.map((item) => [normalizeArtistIdentity(item.artist), item.score]));
  const rows = db.prepare(`
    SELECT artist, MAX(play_count) AS play_count, MAX(updated_at) AS updated_at
    FROM tracks
    WHERE trim(artist) <> ''
    GROUP BY lower(artist)
    ORDER BY play_count DESC, updated_at DESC
    LIMIT $limit
  `).all({ $limit: Number(process.env.RECO_ARTIST_GRAPH_LIMIT ?? 300) }) as Array<{
    artist: string; play_count: number; updated_at: number;
  }>;
  const artists = [...new Set([
    ...profile.topArtists.map((item) => item.artist),
    ...rows.map((row) => row.artist),
  ])].slice(0, Number(process.env.RECO_ARTIST_GRAPH_LIMIT ?? 300));
  const now = Math.floor(Date.now() / 1000);
  let edges = 0;
  for (const artist of artists) {
    const key = normalizeArtistIdentity(artist);
    if (!key) continue;
    const existing = db.prepare(`
      SELECT MAX(updated_at) AS updated_at FROM related_artists
      WHERE artist_key = $artistKey AND source = 'lastfm'
    `).get({ $artistKey: key }) as { updated_at: number | null } | null;
    if (existing?.updated_at && now - Number(existing.updated_at) < 30 * 86400 && !profileArtists.has(key)) continue;
    const similar = await getSimilarArtists(artist, 50).catch(() => []);
    db.transaction(() => {
      const upsert = db.prepare(`
        INSERT INTO related_artists (artist_key, related_key, score, source, updated_at)
        VALUES ($artistKey, $relatedKey, $score, 'lastfm', $updatedAt)
        ON CONFLICT(artist_key, related_key, source) DO UPDATE SET
          score = excluded.score, updated_at = excluded.updated_at
      `);
      for (const item of similar) {
        const relatedKey = normalizeArtistIdentity(item.artist);
        if (!relatedKey || relatedKey === key || item.match < 0.15) continue;
        upsert.run({
          $artistKey: key,
          $relatedKey: relatedKey,
          $score: item.match,
          $updatedAt: now,
        });
        edges++;
      }
    })();
    await sleep(250);
  }
  return { artists: artists.length, edges };
}
