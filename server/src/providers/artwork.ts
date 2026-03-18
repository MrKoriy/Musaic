/**
 * Online Artwork Provider
 *
 * Fetches album art from free public APIs:
 *   1. iTunes Search API (primary) — no auth required
 *   2. Deezer API (fallback)       — no auth required
 */

export interface ArtworkResult {
  url: string;
  source: "itunes" | "deezer";
}

/**
 * Fetch artwork URL for a given artist + title.
 * Returns null if neither source returns a result.
 */
export async function fetchOnlineArtwork(
  artist: string,
  title: string
): Promise<ArtworkResult | null> {
  // 1. iTunes Search API
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(
      `https://itunes.apple.com/search?term=${q}&entity=song&limit=1`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        results?: Array<{ artworkUrl100?: string }>;
      };
      const raw = data.results?.[0]?.artworkUrl100;
      if (raw) {
        // Upgrade to 600×600 from default 100×100
        return {
          url: raw.replace("/100x100bb.", "/600x600bb."),
          source: "itunes",
        };
      }
    }
  } catch {
    // fall through to Deezer
  }

  // 2. Deezer API
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(
      `https://api.deezer.com/search?q=${q}&limit=1`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        data?: Array<{
          album?: { cover_big?: string; cover_medium?: string };
        }>;
      };
      const coverUrl =
        data.data?.[0]?.album?.cover_big ??
        data.data?.[0]?.album?.cover_medium;
      if (coverUrl) {
        return { url: coverUrl, source: "deezer" };
      }
    }
  } catch {
    // no artwork found
  }

  return null;
}
