import { getDb } from "../db/index.js";
import { getLastfmKey, getSimilarTracks } from "../providers/lastfm.js";
import { normalizeArtistIdentity } from "../utils/track-identity.js";

interface HistoryEvent {
  track_id: string;
  session_id: string;
  played_at: number;
  action: string;
  played_ratio: number | null;
}

function accepted(event: HistoryEvent): boolean {
  return event.action === "complete" || (event.action === "play" && event.played_ratio == null)
    || (event.played_ratio != null && event.played_ratio >= 0.5);
}

function recencyWeight(playedAt: number): number {
  const ageDays = Math.max(0, (Date.now() / 1000 - playedAt) / 86400);
  return Math.exp(-Math.LN2 * ageDays / 30);
}

function addPair(map: Map<string, number>, left: string, right: string, score: number): void {
  if (!left || !right || left === right) return;
  const key = `${left}\u0000${right}`;
  map.set(key, (map.get(key) ?? 0) + score);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSimilarItemsJob(): Promise<{ coListenPairs: number; lastfmPairs: number }> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 180 * 86400;
  const events = db.prepare(`
    SELECT track_id, session_id, played_at, action, played_ratio
    FROM listening_history
    WHERE session_id IS NOT NULL AND played_at >= $cutoff
      AND action IN ('play', 'complete', 'skip')
    ORDER BY session_id, played_at, id
  `).all({ $cutoff: cutoff }) as HistoryEvent[];
  const pairs = new Map<string, number>();
  const totals = new Map<string, number>();
  let currentSession = "";
  let sessionTracks: HistoryEvent[] = [];
  const flush = () => {
    const unique = [...new Map(sessionTracks.filter(accepted).map((event) => [event.track_id, event])).values()];
    for (const event of unique) totals.set(event.track_id, (totals.get(event.track_id) ?? 0) + recencyWeight(event.played_at));
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const weight = Math.min(recencyWeight(unique[i].played_at), recencyWeight(unique[j].played_at))
          * (0.7 + 0.6 * Math.max(unique[i].played_ratio ?? 1, unique[j].played_ratio ?? 1));
        addPair(pairs, unique[i].track_id, unique[j].track_id, weight);
        addPair(pairs, unique[j].track_id, unique[i].track_id, weight);
      }
    }
  };
  for (const event of events) {
    if (event.session_id !== currentSession || (sessionTracks.at(-1) && event.played_at - sessionTracks.at(-1)!.played_at > 45 * 60)) {
      flush();
      sessionTracks = [];
      currentSession = event.session_id;
    }
    sessionTracks.push(event);
  }
  flush();

  const upsert = db.prepare(`
    INSERT INTO similar_items (track_id, other_id, score, source, updated_at)
    VALUES ($trackId, $otherId, $score, 'co_listen', unixepoch())
    ON CONFLICT(track_id, other_id, source) DO UPDATE SET
      score = excluded.score, updated_at = excluded.updated_at
  `);
  const topByTrack = new Map<string, Array<{ other: string; score: number }>>();
  for (const [key, rawScore] of pairs) {
    const [trackId, otherId] = key.split("\u0000");
    const normalized = rawScore / (Math.sqrt((totals.get(trackId) ?? 1) * (totals.get(otherId) ?? 1)) + 5);
    if (normalized < 0.01) continue;
    const list = topByTrack.get(trackId) ?? [];
    list.push({ other: otherId, score: normalized });
    topByTrack.set(trackId, list);
  }
  db.transaction(() => {
    db.prepare("DELETE FROM similar_items WHERE source = 'co_listen'").run();
    for (const [trackId, list] of topByTrack) {
      for (const item of list.sort((a, b) => b.score - a.score).slice(0, 50)) {
        upsert.run({ $trackId: trackId, $otherId: item.other, $score: item.score });
      }
    }
  })();

  let lastfmPairs = 0;
  if (getLastfmKey()) {
    const ids = (db.prepare(`
      SELECT track_id FROM (
        SELECT track_id, COUNT(*) AS frequency
        FROM listening_history
        WHERE played_at >= $cutoff AND action IN ('play', 'complete', 'like')
        GROUP BY track_id
        UNION ALL
        SELECT track_id, 100000 AS frequency FROM liked_tracks
      )
      GROUP BY track_id ORDER BY MAX(frequency) DESC, COUNT(*) DESC LIMIT 150
    `).all({ $cutoff: cutoff }) as Array<{ track_id: string }>).map((row) => row.track_id);
    const trackRows = ids.length === 0 ? [] : db.prepare(`
      SELECT id, artist, title FROM tracks WHERE id IN (${ids.map((_, index) => `$id${index}`).join(", ")})
    `).all(Object.fromEntries(ids.map((id, index) => [`$id${index}`, id]))) as Array<{ id: string; artist: string; title: string }>;
    const insertLastfm = db.prepare(`
      INSERT INTO similar_items (track_id, other_id, score, source, updated_at)
      VALUES ($trackId, $otherId, $score, 'lastfm', unixepoch())
      ON CONFLICT(track_id, other_id, source) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at
    `);
    for (const seed of trackRows) {
      const similar = await getSimilarTracks(seed.artist, seed.title, 30).catch(() => []);
      for (const item of similar) {
        const match = db.prepare(`
          SELECT id FROM tracks
          WHERE lower(artist) LIKE lower($artist) AND lower(title) LIKE lower($title)
          ORDER BY play_count DESC LIMIT 1
        `).get({ $artist: `%${item.artist}%`, $title: `%${item.title}%` }) as { id: string } | null;
        if (!match || match.id === seed.id) continue;
        insertLastfm.run({ $trackId: seed.id, $otherId: match.id, $score: item.match * 0.3 });
        lastfmPairs++;
      }
      await sleep(50);
    }
  }
  db.prepare("DELETE FROM similar_items WHERE updated_at < unixepoch() - 60 * 86400").run();
  return { coListenPairs: pairs.size, lastfmPairs };
}

export function relatedArtistKeys(artist: string, max = 20): Array<{ key: string; score: number; depth: number }> {
  const db = getDb();
  const root = normalizeArtistIdentity(artist);
  if (!root) return [];
  const direct = db.prepare(`
    SELECT related_key, score FROM related_artists
    WHERE artist_key = $artistKey ORDER BY score DESC LIMIT $limit
  `).all({ $artistKey: root, $limit: max }) as Array<{ related_key: string; score: number }>;
  const output = direct.map((item) => ({ key: item.related_key, score: item.score, depth: 1 }));
  for (const item of direct.slice(0, 10)) {
    const second = db.prepare(`
      SELECT related_key, score FROM related_artists
      WHERE artist_key = $artistKey ORDER BY score DESC LIMIT 10
    `).all({ $artistKey: item.related_key }) as Array<{ related_key: string; score: number }>;
    for (const child of second) {
      if (child.related_key === root) continue;
      output.push({ key: child.related_key, score: item.score * child.score * 0.5, depth: 2 });
    }
  }
  const best = new Map<string, { key: string; score: number; depth: number }>();
  for (const item of output) {
    if (!best.has(item.key) || best.get(item.key)!.score < item.score) best.set(item.key, item);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, max * 2);
}
