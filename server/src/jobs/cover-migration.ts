import { getDb, setPlaylistCoverPath, setTrackCoverPath } from "../db/index.js";
import { readCoverFile, writeCoverFile } from "../utils/cover-storage.js";

export interface CoverMigrationResult {
  tracks: number;
  playlists: number;
}

/** Copy legacy BLOB covers to disk while retaining the BLOB fallback. */
export function runCoverMigrationJob(limit = 500): CoverMigrationResult {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 5_000));
  let tracks = 0;
  let playlists = 0;

  const trackRows = db.prepare(`
    SELECT cd.track_id, cd.data, cd.mime_type, t.cover_path
    FROM cover_data cd JOIN tracks t ON t.id = cd.track_id
    WHERE t.cover_path IS NULL
    LIMIT $limit
  `).all({ $limit: safeLimit }) as Array<{
    track_id: string;
    data: Buffer;
    mime_type: string;
    cover_path: string | null;
  }>;
  for (const row of trackRows) {
    const relativePath = writeCoverFile(row.track_id, Buffer.from(row.data), row.mime_type);
    if (!readCoverFile(relativePath)) continue;
    setTrackCoverPath(row.track_id, relativePath);
    tracks++;
  }

  const playlistRows = db.prepare(`
    SELECT playlist_id, data, mime_type, file_path
    FROM playlist_cover_data
    WHERE file_path IS NULL
    LIMIT $limit
  `).all({ $limit: safeLimit }) as Array<{
    playlist_id: string;
    data: Buffer;
    mime_type: string;
    file_path: string | null;
  }>;
  for (const row of playlistRows) {
    const relativePath = writeCoverFile(row.playlist_id, Buffer.from(row.data), row.mime_type, true);
    if (!readCoverFile(relativePath)) continue;
    setPlaylistCoverPath(row.playlist_id, relativePath);
    playlists++;
  }

  if (tracks || playlists) {
    console.log(`[covers] migrated ${tracks} track cover(s) and ${playlists} playlist cover(s) to disk`);
  }
  return { tracks, playlists };
}
