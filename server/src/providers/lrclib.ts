/**
 * LRCLIB provider — free synced lyrics lookup.
 *
 * API: https://lrclib.net/api/get?artist_name={artist}&track_name={title}&duration={seconds}
 * No auth required. 3M+ synced lyrics covering mainstream + indie.
 */

const LRCLIB_BASE = "https://lrclib.net/api";
const MAX_RETRIES = 2;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch synced LRC lyrics from LRCLIB.
 * Returns LRC string (with timestamps) if found, null otherwise.
 * Retries up to MAX_RETRIES times on 5xx errors.
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${LRCLIB_BASE}/get?${params}`, {
        headers: { "Lrclib-Client": "Musaic/0.1 (https://github.com/musaic-app)" },
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 404) return null;

      if (res.status >= 500 && attempt < MAX_RETRIES) {
        console.warn(`[lrclib] Server error ${res.status} for "${artist} - ${title}" — retry ${attempt + 1}/${MAX_RETRIES}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        console.warn(`[lrclib] API error ${res.status} for "${artist} - ${title}"`);
        return null;
      }

      const data = (await res.json()) as LrclibResponse;

      if (data.instrumental) return null;

      if (data.syncedLyrics) {
        return { lrc: data.syncedLyrics, source: "lrclib" };
      }

      if (data.plainLyrics) {
        const lrc = plainToLrc(data.plainLyrics);
        return { lrc, source: "lrclib" };
      }

      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        console.warn(`[lrclib] Fetch error for "${artist} - ${title}": ${msg} — retry ${attempt + 1}/${MAX_RETRIES}`);
        await sleep(1000 * (attempt + 1));
      } else {
        console.warn(`[lrclib] Fetch failed for "${artist} - ${title}" after ${MAX_RETRIES + 1} attempts: ${msg}`);
      }
    }
  }

  return null;
}

/**
 * Search LRCLIB by query string (fallback when exact match fails)
 */
export async function searchLrclib(
  query: string
): Promise<{ lrc: string; source: "lrclib" } | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`, {
        headers: { "Lrclib-Client": "Musaic/0.1" },
        signal: AbortSignal.timeout(8000),
      });

      if (res.status >= 500 && attempt < MAX_RETRIES) {
        console.warn(`[lrclib] Search server error ${res.status} — retry ${attempt + 1}/${MAX_RETRIES}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }

      if (!res.ok) return null;

      const results = (await res.json()) as LrclibResponse[];
      const first = results.find((r) => r.syncedLyrics || r.plainLyrics);
      if (!first) return null;

      const lrc = first.syncedLyrics ?? plainToLrc(first.plainLyrics ?? "");
      return { lrc, source: "lrclib" };
    } catch {
      if (attempt >= MAX_RETRIES) return null;
      await sleep(1000 * (attempt + 1));
    }
  }

  return null;
}

/** Convert plain text lyrics to a minimal LRC without timestamps */
function plainToLrc(plain: string): string {
  return plain
    .split("\n")
    .map((line) => `[00:00.00] ${line}`)
    .join("\n");
}
