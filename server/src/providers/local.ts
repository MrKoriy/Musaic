/**
 * Local FLAC Provider
 *
 * Phase 2 placeholder — reads from SQLite tracks indexed from local files.
 * Full implementation (folder scanning, music-metadata) comes in Phase 2.
 */

import { getDb } from "../db/index.js";
import type { Track, TrackMeta, MusicProvider } from "../types.js";
import path from "path";
import fs from "fs";

export class LocalFLACProvider implements MusicProvider {
  constructor(private musicDir: string) {}

  async search(query: string): Promise<Track[]> {
    const db = getDb();
    const q = query.trim();
    if (!q) return [];
    // FTS5 search
    const rows = db
      .prepare(
        `SELECT t.* FROM tracks t
         JOIN tracks_fts fts ON t.rowid = fts.rowid
         WHERE fts MATCH $q AND t.source = 'local'
         ORDER BY rank LIMIT 50`
      )
      .all({ $q: `${q}*` }) as Record<string, unknown>[];
    return rows.map(rowToTrack);
  }

  async getStreamUrl(trackId: string): Promise<string> {
    const db = getDb();
    const row = db
      .prepare("SELECT local_path FROM tracks WHERE id = $id AND source = 'local'")
      .get({ $id: trackId }) as { local_path: string | null } | null;
    if (!row?.local_path) throw new Error(`Local track not found: ${trackId}`);
    // Return a relative URL — the server will serve the file
    return `/audio/local/${encodeURIComponent(trackId)}`;
  }

  async getTrackMetadata(trackId: string): Promise<TrackMeta> {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM tracks WHERE id = $id AND source = 'local'")
      .get({ $id: trackId }) as Record<string, unknown> | null;
    if (!row) throw new Error(`Local track not found: ${trackId}`);
    return {
      id: row.id as string,
      source: "local",
      title: row.title as string,
      artist: row.artist as string,
      album: row.album as string | undefined,
      duration: row.duration as number,
      coverUrl: row.cover_url as string | undefined,
    };
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM tracks WHERE source = 'local' AND LOWER(artist) = LOWER($artist) LIMIT 100"
      )
      .all({ $artist: artistId }) as Record<string, unknown>[];
    return rows.map(rowToTrack);
  }

  /** Serve a local audio file as a readable stream */
  getFilePath(trackId: string): string | null {
    const db = getDb();
    const row = db
      .prepare("SELECT local_path FROM tracks WHERE id = $id AND source = 'local'")
      .get({ $id: trackId }) as { local_path: string | null } | null;
    return row?.local_path ?? null;
  }
}

function rowToTrack(row: Record<string, unknown>): Track {
  return {
    id: row.id as string,
    source: row.source as "local" | "vk" | "soundcloud",
    title: row.title as string,
    artist: row.artist as string,
    album: row.album as string | undefined,
    duration: row.duration as number,
    coverUrl: row.cover_url as string | undefined,
    localPath: row.local_path as string | undefined,
    waveformUrl: row.waveform_url as string | undefined,
  };
}

let _provider: LocalFLACProvider | null = null;
export function getLocalProvider(): LocalFLACProvider {
  if (!_provider) {
    _provider = new LocalFLACProvider(
      process.env.MUSIC_DIR ?? path.join(process.cwd(), "music")
    );
  }
  return _provider;
}
