/**
 * LRCLIB provider — free synced lyrics lookup.
 *
 * API: https://lrclib.net/api/get?artist_name={artist}&track_name={title}&duration={seconds}
 * No auth required. 3M+ synced lyrics covering mainstream + indie.
 */

const LRCLIB_BASE = "https://lrclib.net/api";

interface LrclibResponse {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

/**
 * Fetch synced LRC lyrics from LRCLIB.
 * Returns LRC string (with timestamps) if found, null otherwise.
 */
export async function fetchLrclib(
  artist: string,
  title: string,
  durationSec?: number
): Promise<{ lrc: string; source: "lrclib" } | null> {
  const params = new URLSearchParams({
    artist_name: artist,
    track_name: title,
  });
  if (durationSec != null) {
    params.set("duration", String(Math.round(durationSec)));
  }

  try {
    const res = await fetch(`${LRCLIB_BASE}/get?${params}`, {
      headers: { "Lrclib-Client": "Musaic/0.1 (https://github.com/musaic-app)" },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[lrclib] API error: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as LrclibResponse;

    if (data.instrumental) {
      // Instrumental — no lyrics
      return null;
    }

    if (data.syncedLyrics) {
      return { lrc: data.syncedLyrics, source: "lrclib" };
    }

    if (data.plainLyrics) {
      // Convert plain lyrics to minimal LRC (no timestamps, but still displayable)
      const lrc = plainToLrc(data.plainLyrics);
      return { lrc, source: "lrclib" };
    }

    return null;
  } catch (err: unknown) {
    console.warn(`[lrclib] Fetch failed for "${artist} - ${title}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Search LRCLIB by query string (fallback when exact match fails)
 */
export async function searchLrclib(
  query: string
): Promise<{ lrc: string; source: "lrclib" } | null> {
  try {
    const res = await fetch(`${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`, {
      headers: { "Lrclib-Client": "Musaic/0.1" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const results = (await res.json()) as LrclibResponse[];
    const first = results.find((r) => r.syncedLyrics || r.plainLyrics);
    if (!first) return null;

    const lrc = first.syncedLyrics ?? plainToLrc(first.plainLyrics ?? "");
    return { lrc, source: "lrclib" };
  } catch {
    return null;
  }
}

/** Convert plain text lyrics to a minimal LRC without timestamps */
function plainToLrc(plain: string): string {
  return plain
    .split("\n")
    .map((line) => `[00:00.00] ${line}`)
    .join("\n");
}
