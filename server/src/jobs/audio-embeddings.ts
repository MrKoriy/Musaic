import { getDb } from "../db/index.js";
import { encodeEmbedding, fetchAudioEmbedding } from "../reco/audio.js";

export async function runAudioEmbeddingsJob(): Promise<{ processed: number; embedded: number }> {
  if (process.env.AUDIO_EMBEDDINGS_ENABLED !== "1") return { processed: 0, embedded: 0 };
  const db = getDb();
  const limit = Math.max(1, Math.min(Number(process.env.RECO_AUDIO_EMBEDDING_LIMIT ?? 50), 200));
  const rows = db.prepare(`
    SELECT t.id, t.local_path
    FROM tracks t
    LEFT JOIN audio_embeddings ae ON ae.track_id = t.id
    WHERE t.source = 'local' AND t.local_path IS NOT NULL
      AND (ae.updated_at IS NULL OR ae.updated_at < unixepoch() - 30 * 86400)
    ORDER BY t.updated_at DESC LIMIT $limit
  `).all({ $limit: limit }) as Array<{ id: string; local_path: string }>;
  const insert = db.prepare(`
    INSERT INTO audio_embeddings (track_id, vector, dimensions, updated_at)
    VALUES ($trackId, $vector, $dimensions, unixepoch())
    ON CONFLICT(track_id) DO UPDATE SET vector = excluded.vector,
      dimensions = excluded.dimensions, updated_at = excluded.updated_at
  `);
  let embedded = 0;
  for (const row of rows) {
    try {
      const vector = await fetchAudioEmbedding(row.local_path);
      insert.run({ $trackId: row.id, $vector: encodeEmbedding(vector), $dimensions: vector.length });
      embedded++;
    } catch {
      // One corrupt/missing local file must not stop the batch.
    }
  }
  return { processed: rows.length, embedded };
}
