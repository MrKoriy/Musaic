/**
 * Unified search route — merges results from all providers
 */

import { Hono } from "hono";
import { getVKProvider } from "../providers/vk.js";
import { getLocalProvider } from "../providers/local.js";
import { getSoundCloudProvider } from "../providers/soundcloud.js";
import { hydrateCachedCoverUrls } from "../providers/artwork.js";
import type { Track } from "../types.js";
import type { ExternalPlaylist } from "../providers/soundcloud.js";

const router = new Hono();

/**
 * GET /api/search?q=query&sources=local,vk,soundcloud
 * Returns { tracks, playlists, bySource, errors }
 */
router.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "q required" }, 400);

  const sourcesParam = c.req.query("sources") ?? "local,vk,soundcloud";
  const sources = sourcesParam.split(",").map((s) => s.trim());
  const limit = Math.min(Number(c.req.query("limit") ?? 30), 50);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const fetchWindow = Math.min(limit + offset, 100);

  const results: Record<string, Track[]> = {};
  const playlists: ExternalPlaylist[] = [];
  const errors: Record<string, string> = {};

  const tasks: Promise<void>[] = [];

  if (sources.includes("local")) {
    tasks.push(
      getLocalProvider()
        .search(q)
        .then((t) => { results.local = t; })
        .catch((e: unknown) => { errors.local = e instanceof Error ? e.message : String(e); })
    );
  }

  if (sources.includes("vk") && getVKProvider().isAuthenticated()) {
    tasks.push(
      getVKProvider()
        .search(q)
        .then((t) => { results.vk = t; })
        .catch((e: unknown) => { errors.vk = e instanceof Error ? e.message : String(e); })
    );
    tasks.push(
      getVKProvider()
        .searchPlaylists(q)
        .then((p) => { playlists.push(...p); })
        .catch(() => {})
    );
  }

  if (sources.includes("soundcloud")) {
    tasks.push(
      getSoundCloudProvider()
        .search(q, fetchWindow, offset)
        .then((t) => { results.soundcloud = t; })
        .catch((e: unknown) => { errors.soundcloud = e instanceof Error ? e.message : String(e); })
    );
    tasks.push(
      getSoundCloudProvider()
        .searchPlaylists(q, 5)
        .then((p) => { playlists.push(...p); })
        .catch(() => {})
    );
  }

  await Promise.all(tasks);

  // Merge: local first (best quality), then VK, then SoundCloud — deduplicate by artist+title
  const allTracks: Track[] = [
    ...(results.local ?? []),
    ...(results.vk ?? []),
    ...(results.soundcloud ?? []),
  ];
  const seen = new Map<string, Track>();
  for (const t of allTracks) {
    const key = `${(t.artist ?? "").toLowerCase().trim()}|${(t.title ?? "").toLowerCase().trim()}`;
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
    stream_url: t.streamUrl,
    local_path: t.localPath,
    waveform_url: t.waveformUrl,
  });

  const normalisedMerged = merged.slice(offset, offset + limit).map(normalise);
  const normalisedBySource: Record<string, ReturnType<typeof normalise>[]> = {};
  for (const [src, tracks] of Object.entries(results)) {
    normalisedBySource[src] = tracks.slice(offset, offset + limit).map(normalise);
  }

  return c.json({
    query: q,
    tracks: normalisedMerged,
    playlists: playlists.length > 0 ? playlists : undefined,
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
        stream_url: t.streamUrl, waveform_url: t.waveformUrl,
      });
      return c.json({ tracks: tracks.map(normalise) });
    }

    if (id.startsWith("vk_playlist_")) {
      const parts = id.replace("vk_playlist_", "").split("_");
      const ownerId = Number(parts[0]);
      const playlistId = Number(parts[1]);
      const tracks = await getVKProvider().getPlaylistTracks(playlistId, ownerId);
      const normalise = (t: Track) => ({
        id: t.id, source: t.source, title: t.title, artist: t.artist,
        album: t.album, duration: t.duration, cover_url: t.coverUrl,
        stream_url: t.streamUrl,
      });
      return c.json({ tracks: tracks.map(normalise) });
    }

    return c.json({ error: "Unknown playlist source" }, 400);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to load playlist" }, 500);
  }
});

export default router;
