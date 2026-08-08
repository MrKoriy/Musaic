/**
 * Unified search route — merges results from all providers
 */

import { Hono } from "hono";
import { getYandexProvider, searchCachedYandexTracks } from "../providers/yandex.js";
import { getYouTubeProvider, searchCachedYouTubeTracks } from "../providers/youtube.js";
import { getLocalProvider } from "../providers/local.js";
import { getSoundCloudProvider } from "../providers/soundcloud.js";
import { hydrateCachedCoverUrls } from "../providers/artwork.js";
import { normaliseArtistSources, searchArtists } from "../providers/artists.js";
import type { Track } from "../types.js";
import type { ExternalPlaylist } from "../providers/soundcloud.js";
import { songFamilyKey } from "../utils/track-identity.js";

const router = new Hono();

/**
 * GET /api/search?q=query&sources=local,vk,soundcloud
 * Returns { tracks, playlists, bySource, errors }
 */
router.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "q required" }, 400);

  // VK is intentionally excluded from discovery — its audio API is dead for new
  // tracks. Liked VK tracks still play (stream dispatch keeps a VK branch), but
  // search/recommendations surface only living sources.
  const sourcesParam = c.req.query("sources") ?? "local,yandex,youtube,soundcloud";
  const sources = sourcesParam.split(",").map((s) => s.trim());
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 30), 100));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  // Each provider paginates from `offset` and returns up to `limit` items.
  // We over-fetch slightly so dedup loss across sources doesn't shrink the page.
  const perProviderLimit = Math.min(limit + 10, 100);

  const results: Record<string, Track[]> = {};
  const playlists: ExternalPlaylist[] = [];
  let artists: Awaited<ReturnType<typeof searchArtists>> = [];
  const errors: Record<string, string> = {};

  const tasks: Promise<void>[] = [];

  if (sources.includes("local")) {
    tasks.push(
      getLocalProvider()
        .search(q, perProviderLimit, offset)
        .then((t) => { results.local = t; })
        .catch((e: unknown) => { errors.local = e instanceof Error ? e.message : String(e); })
    );
  }

  if (sources.includes("yandex")) {
    if (getYandexProvider().isAuthenticated()) {
      tasks.push(
        getYandexProvider()
          .search(q, perProviderLimit, offset)
          .then((t) => { results.yandex = t; })
          .catch((e: unknown) => {
            errors.yandex = e instanceof Error ? e.message : String(e);
            results.yandex = searchCachedYandexTracks(q, perProviderLimit, offset);
          })
      );
    } else {
      errors.yandex = "Yandex is not connected. Add your Yandex token in Settings.";
      results.yandex = searchCachedYandexTracks(q, perProviderLimit, offset);
    }
  }

  if (sources.includes("youtube")) {
    tasks.push(
      getYouTubeProvider()
        .search(q, perProviderLimit, offset)
        .then((t) => { results.youtube = t; })
        .catch((e: unknown) => {
          errors.youtube = e instanceof Error ? e.message : String(e);
          results.youtube = searchCachedYouTubeTracks(q, perProviderLimit, offset);
        })
    );
  }

  if (sources.includes("soundcloud")) {
    tasks.push(
      getSoundCloudProvider()
        .search(q, perProviderLimit, offset)
        .then((t) => { results.soundcloud = t; })
        .catch((e: unknown) => { errors.soundcloud = e instanceof Error ? e.message : String(e); })
    );
    if (offset === 0) {
      tasks.push(
        getSoundCloudProvider()
          .searchPlaylists(q, 5)
          .then((p) => { playlists.push(...p); })
          .catch(() => {})
      );
    }
  }

  if (offset === 0) {
    tasks.push(
      searchArtists(q, normaliseArtistSources(sourcesParam), 8)
        .then((a) => { artists = a; })
        .catch(() => {})
    );
  }

  await Promise.all(tasks);

  // Merge: local first (best quality), then Yandex, YouTube, SoundCloud — dedup by artist+title
  const allTracks: Track[] = [
    ...(results.local ?? []),
    ...(results.yandex ?? []),
    ...(results.youtube ?? []),
    ...(results.soundcloud ?? []),
  ];
  const seen = new Map<string, Track>();
  for (const t of allTracks) {
    const key = songFamilyKey(t);
    if (!seen.has(key)) seen.set(key, t);
  }
  // Enrich from DB cache for any tracks missing artwork (fast, no external calls)
  const merged: Track[] = hydrateCachedCoverUrls([...seen.values()]);

  const normalise = (t: Track) => ({
    id: t.id,
    source: t.source,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    cover_url: t.coverUrl,
    waveform_url: t.waveformUrl,
  });

  const normalisedMerged = merged.slice(0, limit).map(normalise);
  const normalisedBySource: Record<string, ReturnType<typeof normalise>[]> = {};
  for (const [src, tracks] of Object.entries(results)) {
    normalisedBySource[src] = tracks.slice(0, limit).map(normalise);
  }

  // hasMore: providers can filter/dedupe after fetching, so a source returning
  // `limit` visible items is enough signal to let the client ask for the next page.
  const hasMore = merged.length > limit || Object.values(results).some((t) => t.length >= limit);

  return c.json({
    query: q,
    offset,
    limit,
    hasMore,
    tracks: normalisedMerged,
    playlists: playlists.length > 0 ? playlists : undefined,
    artists: artists.length > 0 ? artists : undefined,
    bySource: normalisedBySource,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
});

/**
 * GET /api/search/playlist/:playlistId/tracks
 * Fetch tracks from a SC or VK playlist
 */
router.get("/playlist/:playlistId/tracks", async (c) => {
  const id = decodeURIComponent(c.req.param("playlistId"));

  try {
    if (id.startsWith("sc_playlist_")) {
      const tracks = await getSoundCloudProvider().getPlaylistTracks(id);
      const normalise = (t: Track) => ({
        id: t.id, source: t.source, title: t.title, artist: t.artist,
        album: t.album, duration: t.duration, cover_url: t.coverUrl,
        waveform_url: t.waveformUrl,
      });
      return c.json({ tracks: tracks.map(normalise) });
    }

    if (id.startsWith("vk_playlist_")) {
      // VK is gone from discovery, but a previously-imported VK playlist can
      // still be opened — load its provider on demand for playback.
      const { getVKProvider } = await import("../providers/vk.js");
      const parts = id.replace("vk_playlist_", "").split("_");
      const ownerId = Number(parts[0]);
      const playlistId = Number(parts[1]);
      const tracks = await getVKProvider().getPlaylistTracks(playlistId, ownerId);
      const normalise = (t: Track) => ({
        id: t.id, source: t.source, title: t.title, artist: t.artist,
        album: t.album, duration: t.duration, cover_url: t.coverUrl,
      });
      return c.json({ tracks: tracks.map(normalise) });
    }

    return c.json({ error: "Unknown playlist source" }, 400);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to load playlist" }, 500);
  }
});

export default router;
