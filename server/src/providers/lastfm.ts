import { getCached, getOrSetCached } from "./taste-engine.js";

const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";
const MIN_REQUEST_INTERVAL_MS = 220;
let lastRequestAt = 0;
let requestChain: Promise<void> = Promise.resolve();

export interface LastfmSimilarItem {
  artist: string;
  title: string;
  match: number;
}

export interface LastfmTag {
  name: string;
  count: number;
}

export function getLastfmKey(): string | null {
  return process.env.LASTFM_API_KEY?.trim() || null;
}

async function waitForRateLimit(): Promise<void> {
  let release!: () => void;
  const previous = requestChain;
  requestChain = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const delay = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
  release();
}

export async function lastfmGet<T>(params: Record<string, string>): Promise<T> {
  const key = getLastfmKey();
  if (!key) throw new Error("LASTFM_API_KEY not set");
  await waitForRateLimit();
  const query = new URLSearchParams({ ...params, api_key: key, format: "json" });
  const response = await fetch(`${LASTFM_BASE}?${query}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Last.fm error: ${response.status}`);
  return await response.json() as T;
}

function cachedKey(prefix: string, ...parts: string[]): string {
  return `lastfm:${prefix}:${parts.map((part) => part.trim().toLowerCase()).join("::")}`;
}

export async function getSimilarArtists(artist: string, limit = 50): Promise<Array<{ artist: string; match: number }>> {
  const key = cachedKey("artist-similar", artist);
  const cached = getCached<Array<{ artist: string; match: number }>>(key);
  if (cached) return cached.slice(0, limit);
  const result = await getOrSetCached(key, async () => {
    const data = await lastfmGet<{
      similarartists?: { artist?: Array<{ name?: string; match?: number | string }> };
    }>({ method: "artist.getSimilar", artist, limit: String(Math.min(limit, 100)), autocorrect: "1" });
    return (data.similarartists?.artist ?? []).flatMap((item) => {
      const name = item.name?.trim();
      const match = Number(item.match ?? 0);
      return name && Number.isFinite(match) ? [{ artist: name, match: Math.max(0, Math.min(match, 1)) }] : [];
    });
  }, 24 * 3600_000);
  return result.slice(0, limit);
}

export async function getSimilarTracks(artist: string, title: string, limit = 30): Promise<LastfmSimilarItem[]> {
  const key = cachedKey("track-similar", artist, title);
  const cached = getCached<LastfmSimilarItem[]>(key);
  if (cached) return cached.slice(0, limit);
  const result = await getOrSetCached(key, async () => {
    const data = await lastfmGet<{
      similartracks?: { track?: Array<{ name?: string; match?: number | string; artist?: { name?: string } }> };
    }>({ method: "track.getSimilar", artist, track: title, limit: String(Math.min(limit, 100)), autocorrect: "1" });
    return (data.similartracks?.track ?? []).flatMap((item) => {
      const itemArtist = item.artist?.name?.trim();
      const itemTitle = item.name?.trim();
      const match = Number(item.match ?? 0);
      return itemArtist && itemTitle && Number.isFinite(match)
        ? [{ artist: itemArtist, title: itemTitle, match: Math.max(0, Math.min(match, 1)) }]
        : [];
    });
  }, 12 * 3600_000);
  return result.slice(0, limit);
}

export async function getTrackTags(artist: string, title: string, limit = 20): Promise<LastfmTag[]> {
  const key = cachedKey("track-tags", artist, title);
  const cached = getCached<LastfmTag[]>(key);
  if (cached) return cached.slice(0, limit);
  const result = await getOrSetCached(key, async () => {
    const data = await lastfmGet<{ toptags?: { tag?: Array<{ name?: string; count?: number | string }> } }>({
      method: "track.getTopTags", artist, track: title, autocorrect: "1",
    });
    return (data.toptags?.tag ?? []).flatMap((item) => {
      const name = item.name?.trim();
      const count = Number(item.count ?? 0);
      return name ? [{ name, count: Number.isFinite(count) ? count : 0 }] : [];
    });
  }, 24 * 3600_000);
  return result.slice(0, limit);
}

export async function getArtistTags(artist: string, limit = 20): Promise<LastfmTag[]> {
  const key = cachedKey("artist-tags", artist);
  const cached = getCached<LastfmTag[]>(key);
  if (cached) return cached.slice(0, limit);
  const result = await getOrSetCached(key, async () => {
    const data = await lastfmGet<{ toptags?: { tag?: Array<{ name?: string; count?: number | string }> } }>({
      method: "artist.getTopTags", artist, autocorrect: "1",
    });
    return (data.toptags?.tag ?? []).flatMap((item) => {
      const name = item.name?.trim();
      const count = Number(item.count ?? 0);
      return name ? [{ name, count: Number.isFinite(count) ? count : 0 }] : [];
    });
  }, 24 * 3600_000);
  return result.slice(0, limit);
}
