/**
 * downloadService — manages offline audio downloads using expo-file-system and expo-sqlite.
 *
 * Downloaded files are stored in:
 *   FileSystem.documentDirectory + 'downloads/<trackId>.<ext>'
 *
 * A local SQLite database (downloads.db) tracks what's been downloaded.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

export interface DownloadRecord {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  localUri: string;
  fileSize: number; // bytes
  downloadedAt: number; // unix ms
  source: string;
}

type ProgressCallback = (progress: number) => void;

const DOWNLOAD_DIR = FileSystem.documentDirectory + 'downloads/';

let _db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync('downloads.db');
    _db.execSync(`
      CREATE TABLE IF NOT EXISTS downloaded_tracks (
        track_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        artwork TEXT,
        local_uri TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        downloaded_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'local'
      )
    `);
  }
  return _db;
}

/** Ensure the downloads directory exists. */
async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DOWNLOAD_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DOWNLOAD_DIR, { intermediates: true });
  }
}

/** Get the local file URI for a track. */
export function getLocalUri(trackId: string, ext = 'mp3'): string {
  return DOWNLOAD_DIR + trackId + '.' + ext;
}

/** Check if a track is already downloaded. */
export function isDownloaded(trackId: string): boolean {
  try {
    const db = getDb();
    const row = db.getFirstSync<{ track_id: string }>(
      'SELECT track_id FROM downloaded_tracks WHERE track_id = ?', [trackId]
    );
    return row !== null;
  } catch {
    return false;
  }
}

/** Get a single download record. */
export function getDownloadRecord(trackId: string): DownloadRecord | null {
  try {
    const db = getDb();
    const row = db.getFirstSync<{
      track_id: string; title: string; artist: string; album?: string;
      artwork?: string; local_uri: string; file_size: number; downloaded_at: number; source: string;
    }>('SELECT * FROM downloaded_tracks WHERE track_id = ?', [trackId]);
    if (!row) return null;
    return {
      trackId: row.track_id, title: row.title, artist: row.artist,
      album: row.album ?? undefined, artwork: row.artwork ?? undefined,
      localUri: row.local_uri, fileSize: row.file_size,
      downloadedAt: row.downloaded_at, source: row.source,
    };
  } catch {
    return null;
  }
}

/** Get all downloaded tracks sorted by most recent. */
export function getAllDownloads(): DownloadRecord[] {
  try {
    const db = getDb();
    const rows = db.getAllSync<{
      track_id: string; title: string; artist: string; album?: string;
      artwork?: string; local_uri: string; file_size: number; downloaded_at: number; source: string;
    }>('SELECT * FROM downloaded_tracks ORDER BY downloaded_at DESC');
    return rows.map((row) => ({
      trackId: row.track_id, title: row.title, artist: row.artist,
      album: row.album ?? undefined, artwork: row.artwork ?? undefined,
      localUri: row.local_uri, fileSize: row.file_size,
      downloadedAt: row.downloaded_at, source: row.source,
    }));
  } catch {
    return [];
  }
}

/** Total storage used by downloads in bytes. */
export function getTotalStorageBytes(): number {
  try {
    const db = getDb();
    const row = db.getFirstSync<{ total: number }>('SELECT COALESCE(SUM(file_size), 0) as total FROM downloaded_tracks');
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}

/** Format bytes to human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Download a track for offline playback.
 * @param track   App Track object
 * @param serverUrl  Base server URL (e.g. "http://192.168.1.x:3001")
 * @param onProgress Called with 0-1 as download progresses
 * @returns The local file URI
 */
export async function downloadTrack(
  track: { id: string; title: string; artist: string; album?: string; artwork?: string; source: string },
  serverUrl: string,
  onProgress?: ProgressCallback
): Promise<string> {
  await ensureDir();

  const localUri = getLocalUri(track.id, 'mp3');
  const downloadUrl = `${serverUrl}/api/downloads/stream/${encodeURIComponent(track.id)}`;

  // Check if file already exists on disk (resume-safe)
  const existing = await FileSystem.getInfoAsync(localUri);
  if (existing.exists && isDownloaded(track.id)) {
    return localUri;
  }

  const downloadResumable = FileSystem.createDownloadResumable(
    downloadUrl,
    localUri,
    {},
    (progressEvent) => {
      if (progressEvent.totalBytesExpectedToWrite > 0) {
        onProgress?.(progressEvent.totalBytesWritten / progressEvent.totalBytesExpectedToWrite);
      }
    }
  );

  const result = await downloadResumable.downloadAsync();
  if (!result?.uri) throw new Error('Download failed — no result URI');

  // Get actual file size
  const fileInfo = await FileSystem.getInfoAsync(result.uri);
  const fileSize = (fileInfo as any).size ?? 0;

  // Persist to SQLite
  const db = getDb();
  db.runSync(
    `INSERT OR REPLACE INTO downloaded_tracks
      (track_id, title, artist, album, artwork, local_uri, file_size, downloaded_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      track.id, track.title, track.artist,
      track.album ?? null, track.artwork ?? null,
      result.uri, fileSize, Date.now(), track.source,
    ]
  );

  onProgress?.(1);
  return result.uri;
}

/** Delete a downloaded track from disk and DB. */
export async function deleteDownload(trackId: string): Promise<void> {
  const record = getDownloadRecord(trackId);
  if (record) {
    try {
      await FileSystem.deleteAsync(record.localUri, { idempotent: true });
    } catch {
      // If file doesn't exist, continue with DB cleanup
    }
  }
  try {
    const db = getDb();
    db.runSync('DELETE FROM downloaded_tracks WHERE track_id = ?', [trackId]);
  } catch {
    // Ignore DB errors
  }
}

/**
 * For a given track, return the local file URI if downloaded, otherwise the original URL.
 * Use this before playing to support offline playback.
 */
export function resolvePlaybackUrl(trackId: string, originalUrl: string): string {
  const record = getDownloadRecord(trackId);
  return record?.localUri ?? originalUrl;
}

/** Delete all downloads. */
export async function deleteAllDownloads(): Promise<void> {
  const records = getAllDownloads();
  for (const record of records) {
    try {
      await FileSystem.deleteAsync(record.localUri, { idempotent: true });
    } catch {}
  }
  try {
    const db = getDb();
    db.runSync('DELETE FROM downloaded_tracks');
  } catch {}
}
