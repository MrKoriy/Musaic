/**
 * Genius + lyrics.ovh provider — plain-text lyrics fallback.
 *
 * Fetch chain:
 *   1. Genius API (requires GENIUS_ACCESS_TOKEN env var)
 *      → search for song → scrape lyrics from song page
 *   2. lyrics.ovh (free, no auth required) — simple REST API
 *
 * Returns plain text (no LRC timestamps).
 * The LRCLIB provider should be tried first.
 */

const GENIUS_API_BASE = "https://api.genius.com";
const LYRICS_OVH_BASE = "https://api.lyrics.ovh/v1";
const TIMEOUT_MS = 10_000;

interface GeniusSearchHit {
  result: {
    id: number;
    title: string;
    primary_artist: { name: string };
    url: string;
    path: string;
  };
}

interface GeniusSearchResponse {
  response: {
    hits: Array<{ type: string; result: GeniusSearchHit["result"] }>;
  };
}

/**
 * Fetch plain-text lyrics using Genius API + page scraping.
 * Requires GENIUS_ACCESS_TOKEN env var.
 */
async function fetchFromGenius(
  artist: string,
  title: string
): Promise<string | null> {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) return null;

  try {
    const query = `${artist} ${title}`;
    const searchRes = await fetch(
      `${GENIUS_API_BASE}/search?q=${encodeURIComponent(query)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "Musaic/0.1",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );

    if (!searchRes.ok) {
      console.warn(`[genius] Search API error: ${searchRes.status}`);
      return null;
    }

    const searchData = (await searchRes.json()) as GeniusSearchResponse;
    const hit = searchData.response.hits.find((h) => h.type === "song");
    if (!hit) return null;

    const songUrl = hit.result.url;
    console.log(`[genius] Found: "${hit.result.title}" by "${hit.result.primary_artist.name}" — ${songUrl}`);

    const lyrics = await scrapeLyricsFromUrl(songUrl);
    return lyrics;
  } catch (err: unknown) {
    console.warn(`[genius] Failed for "${artist} - ${title}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Scrape plain-text lyrics from a Genius song page.
 */
async function scrapeLyricsFromUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[genius] Page fetch error: ${res.status} for ${url}`);
      return null;
    }

    const html = await res.text();
    return extractLyricsFromHtml(html);
  } catch (err: unknown) {
    console.warn(`[genius] Scrape failed for ${url}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Extract lyrics from Genius HTML page.
 * Lyrics are in <div data-lyrics-container="true"> elements.
 */
function extractLyricsFromHtml(html: string): string | null {
  const marker = 'data-lyrics-container="true"';
  const parts: string[] = [];
  let searchPos = 0;

  while (true) {
    const markerIdx = html.indexOf(marker, searchPos);
    if (markerIdx === -1) break;

    // Find end of opening tag
    const openTagEnd = html.indexOf(">", markerIdx);
    if (openTagEnd === -1) break;

    // Walk the HTML to find the matching closing </div>, tracking nesting depth
    let depth = 1;
    let pos = openTagEnd + 1;
    const contentStart = pos;

    while (depth > 0 && pos < html.length) {
      const nextOpen = html.indexOf("<div", pos);
      const nextClose = html.indexOf("</div>", pos);

      if (nextClose === -1) {
        pos = html.length;
        break;
      }

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) {
          parts.push(html.slice(contentStart, nextClose));
        }
        pos = nextClose + 6;
      }
    }

    searchPos = openTagEnd + 1;
  }

  if (parts.length === 0) return null;

  const processed = parts.map((part) => {
    // <br> → newline
    part = part.replace(/<br\s*\/?>/gi, "\n");
    // Section headers like [Verse 1] are often in <h2> tags or spans
    part = part.replace(/<h[1-6][^>]*>/gi, "\n[");
    part = part.replace(/<\/h[1-6]>/gi, "]\n");
    // Strip remaining HTML tags
    part = part.replace(/<[^>]+>/g, "");
    // Decode HTML entities
    part = part
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .replace(/&#xA0;/g, " ");
    // Normalize whitespace
    part = part.replace(/\n{3,}/g, "\n\n").trim();
    return part;
  });

  const result = processed.filter((p) => p.length > 0).join("\n\n");
  return result || null;
}

/**
 * Fetch plain-text lyrics from lyrics.ovh (free, no auth required).
 */
async function fetchFromLyricsOvh(
  artist: string,
  title: string
): Promise<string | null> {
  try {
    const url = `${LYRICS_OVH_BASE}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Musaic/0.1" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[lyricsovh] API error: ${res.status} for "${artist} - ${title}"`);
      return null;
    }

    const data = (await res.json()) as { lyrics?: string; error?: string };
    if (data.error || !data.lyrics) return null;

    return data.lyrics.trim();
  } catch (err: unknown) {
    console.warn(`[lyricsovh] Failed for "${artist} - ${title}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Main export: fetch plain-text lyrics from Genius or lyrics.ovh.
 * Tries Genius first (if token available), then lyrics.ovh.
 */
export async function fetchPlainLyrics(
  artist: string,
  title: string
): Promise<{ lyrics: string; source: "genius" | "lyricsovh" } | null> {
  // Try Genius if token available
  const geniusLyrics = await fetchFromGenius(artist, title);
  if (geniusLyrics) {
    console.log(`[genius] Found lyrics for "${artist} - ${title}"`);
    return { lyrics: geniusLyrics, source: "genius" };
  }

  // Fallback to lyrics.ovh
  const ovhLyrics = await fetchFromLyricsOvh(artist, title);
  if (ovhLyrics) {
    console.log(`[lyricsovh] Found lyrics for "${artist} - ${title}"`);
    return { lyrics: ovhLyrics, source: "lyricsovh" };
  }

  return null;
}
