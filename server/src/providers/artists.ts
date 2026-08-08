import { getDb } from "../db/index.js";
import { hydrateCachedCoverUrls } from "./artwork.js";
import { getSoundCloudProvider, type ExternalArtist } from "./soundcloud.js";
import { getVKProvider } from "./vk.js";
import { getYandexProvider } from "./yandex.js";
import { getYouTubeProvider } from "./youtube.js";
import type { Track } from "../types.js";

// "vk" remains valid for already-cached/liked VK artists, but it is no longer
// part of discovery (see SOURCE_ORDER) — search surfaces Yandex/YouTube instead.
export type ArtistSource = "local" | "vk" | "soundcloud" | "yandex" | "youtube";

export interface ArtistResult {
  id: string;
  source: ArtistSource | "mixed";
  artist: string;
  track_count: number;
  album_count: number;
  cover_url?: string;
  source_id?: string;
  handle?: string;
  subtitle?: string;
}

export interface ArtistAlbum {
  album: string;
  artist: string;
  track_count: number;
  cover_url?: string;
  source?: ArtistSource | "mixed";
}

export interface ArtistProfile {
  artist: ArtistResult;
  tracks: ReturnType<typeof normaliseTrackForResponse>[];
  albums: ArtistAlbum[];
  available_sources: ArtistSource[];
  errors?: Record<string, string>;
}

// Full ordering — VK kept last so explicitly-requested cached/liked VK data
// still renders in an artist profile.
const SOURCE_ORDER: ArtistSource[] = ["local", "yandex", "youtube", "soundcloud", "vk"];
// Default discovery set — VK excluded so default search and "all" never surface
// new VK results.
const DISCOVERY_SOURCES: ArtistSource[] = ["local", "yandex", "youtube", "soundcloud"];

function sourceLabel(source: string): string {
  switch (source) {
    case "local": return "Local";
    case "vk": return "VK";
    case "yandex": return "Yandex";
    case "youtube": return "YouTube";
    case "soundcloud": return "SoundCloud";
    default: return source;
  }
}

export function normaliseArtistSources(sourcesParam?: string): ArtistSource[] {
  const raw = (sourcesParam ?? "local,yandex,youtube,soundcloud")
    .split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean);
  const requested = raw.includes("all") ? DISCOVERY_SOURCES : raw;
  return SOURCE_ORDER.filter((source) => requested.includes(source));
}

function normalisedText(value: string | undefined | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function slug(value: string): string {
  return normalisedText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function artistId(source: ArtistSource | "mixed", artist: string, sourceId?: string): string {
  return `${source}:${sourceId ?? slug(artist)}`;
}

function albumKey(value: string | undefined | null): string {
  return normalisedText(value);
}

function relevance(query: string, artist: string): number {
  const q = normalisedText(query);
  const name = normalisedText(artist);
  if (!q) return 3;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return 3;
}

function rowToTrack(row: Record<string, unknown>): Track {
  return {
    id: row.id as string,
    source: row.source as ArtistSource,
    title: row.title as string,
    artist: row.artist as string,
    album: row.album as string | undefined,
    duration: Number(row.duration ?? 0),
    coverUrl: row.cover_url as string | undefined,
    localPath: row.local_path as string | undefined,
    waveformUrl: row.waveform_url as string | undefined,
  };
}

export function normaliseTrackForResponse(t: Track) {
  return {
    id: t.id,
    source: t.source,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    cover_url: t.coverUrl,
    waveform_url: t.waveformUrl,
  };
}

function cachedTracksForArtist(artist: string, source: ArtistSource, limit = 120): Track[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT * FROM tracks
      WHERE source = $source AND lower(artist) = lower($artist)
      ORDER BY album ASC, title ASC
      LIMIT $limit
    `)
    .all({ $source: source, $artist: artist, $limit: limit }) as Record<string, unknown>[];
  return rows.map(rowToTrack);
}

function searchCachedArtists(query: string, source: ArtistSource, limit: number): ArtistResult[] {
  const db = getDb();
  const q = normalisedText(query);
  const rows = db
    .prepare(`
      SELECT
        artist,
        source,
        COUNT(*) as track_count,
        COUNT(DISTINCT CASE WHEN album IS NOT NULL AND trim(album) <> '' THEN lower(album) END) as album_count,
        MAX(cover_url) as cover_url
      FROM tracks
      WHERE source = $source AND lower(artist) LIKE $like
      GROUP BY artist, source
      ORDER BY
        CASE
          WHEN lower(artist) = $q THEN 0
          WHEN lower(artist) LIKE $prefix THEN 1
          ELSE 2
        END ASC,
        track_count DESC,
        artist ASC
      LIMIT $limit
    `)
    .all({
      $source: source,
      $q: q,
      $like: `%${q}%`,
      $prefix: `${q}%`,
      $limit: limit,
    }) as Array<{
      artist: string;
      source: ArtistSource;
      track_count: number;
      album_count: number;
      cover_url?: string;
    }>;

  return rows.map((row) => ({
    id: artistId(row.source, row.artist),
    source: row.source,
    artist: row.artist,
    track_count: Number(row.track_count ?? 0),
    album_count: Number(row.album_count ?? 0),
    cover_url: row.cover_url,
    subtitle: sourceLabel(row.source),
  }));
}

function summariseTracksAsArtists(
  tracks: Track[],
  source: ArtistSource,
  query: string,
  limit: number
): ArtistResult[] {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const name = track.artist?.trim();
    if (!name) continue;
    const key = normalisedText(name);
    groups.set(key, [...(groups.get(key) ?? []), track]);
  }

  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      const albums = new Set(group.map((track) => albumKey(track.album)).filter(Boolean));
      return {
        id: artistId(source, first.artist),
        source,
        artist: first.artist,
        track_count: group.length,
        album_count: albums.size,
        cover_url: group.find((track) => track.coverUrl)?.coverUrl,
        subtitle: sourceLabel(source),
      };
    })
    .sort((a, b) =>
      relevance(query, a.artist) - relevance(query, b.artist) ||
      b.track_count - a.track_count ||
      a.artist.localeCompare(b.artist)
    )
    .slice(0, limit);
}

function fromSoundCloudArtist(artist: ExternalArtist): ArtistResult {
  return {
    id: artist.id,
    source: "soundcloud",
    artist: artist.artist,
    track_count: artist.track_count,
    album_count: artist.album_count,
    cover_url: artist.cover_url,
    source_id: artist.source_id,
    handle: artist.handle,
    subtitle: artist.subtitle ?? "SoundCloud",
  };
}

async function searchSoundCloudArtists(query: string, limit: number): Promise<ArtistResult[]> {
  const provider = getSoundCloudProvider();
  const results = (await provider.searchArtists(query, Math.min(limit, 8))).map(fromSoundCloudArtist);
  const primary = results[0];
  const reportedCount = primary?.track_count ?? 0;

  if (primary?.source_id && reportedCount > 0 && reportedCount <= 150 && relevance(query, primary.artist) <= 1) {
    try {
      const tracks = await provider.getArtistTracks(primary.source_id, reportedCount);
      const visibleTracks = dedupeTracksWithinSources(tracks);
      if (visibleTracks.length > 0) {
        primary.track_count = visibleTracks.length;
        primary.album_count = albumsFromTracks(visibleTracks).filter((album) => album.source === "soundcloud").length;
        primary.cover_url = primary.cover_url ?? visibleTracks.find((track) => track.coverUrl)?.coverUrl;
      }
    } catch {
      // Keep SoundCloud's reported user count if the expensive verification fails.
    }
  }

  return results;
}

function mergeArtistResults(results: ArtistResult[], limit: number): ArtistResult[] {
  const groups = new Map<string, ArtistResult[]>();
  for (const result of results) {
    const key = normalisedText(result.artist);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }

  return [...groups.values()]
    .map((group) => {
      const bySource = new Map<ArtistSource | "mixed", ArtistResult>();
      for (const item of group) {
        if (!bySource.has(item.source)) {
          bySource.set(item.source, item);
        }
      }
      const mergedSources = [...bySource.values()];

      // Search providers can return several accounts with the same display name
      // (especially SoundCloud). Treat those as alternatives, not as extra tracks.
      if (mergedSources.length === 1) return mergedSources[0]!;

      const sources = SOURCE_ORDER.filter((source) => mergedSources.some((item) => item.source === source));
      const bestName = [...mergedSources].sort((a, b) =>
        SOURCE_ORDER.indexOf((a.source === "mixed" ? "local" : a.source)) -
          SOURCE_ORDER.indexOf((b.source === "mixed" ? "local" : b.source)) ||
        b.track_count - a.track_count
      )[0]!;
      const coverSourceOrder: Array<ArtistSource | "mixed"> = ["soundcloud", "local", "vk", "mixed"];
      const cover = coverSourceOrder
        .flatMap((source) => mergedSources.filter((item) => item.source === source))
        .find((item) => item.cover_url)?.cover_url;
      const soundcloud = mergedSources.find((item) => item.source === "soundcloud" && item.source_id);

      return {
        id: artistId("mixed", bestName.artist),
        source: "mixed" as const,
        artist: bestName.artist,
        track_count: mergedSources.reduce((sum, item) => sum + item.track_count, 0),
        album_count: Math.max(...mergedSources.map((item) => item.album_count), 0),
        cover_url: cover,
        source_id: soundcloud?.source_id,
        handle: soundcloud?.handle,
        subtitle: sources.map(sourceLabel).join(" + "),
      };
    })
    .slice(0, limit);
}

export async function searchArtists(
  query: string,
  sources: ArtistSource[],
  limit = 8
): Promise<ArtistResult[]> {
  const tasks: Promise<ArtistResult[]>[] = [];

  if (sources.includes("local")) {
    tasks.push(Promise.resolve(searchCachedArtists(query, "local", limit)));
  }

  if (sources.includes("soundcloud")) {
    tasks.push(
      searchSoundCloudArtists(query, limit)
        .catch(() => [])
    );
  }

  if (sources.includes("yandex") && getYandexProvider().isAuthenticated()) {
    tasks.push(
      getYandexProvider()
        .getArtistTracks(query)
        .then((tracks) => summariseTracksAsArtists(tracks, "yandex", query, limit))
        .catch(() => [])
    );
  }

  if (sources.includes("youtube")) {
    tasks.push(
      getYouTubeProvider()
        .getArtistTracks(query)
        .then((tracks) => summariseTracksAsArtists(tracks, "youtube", query, limit))
        .catch(() => [])
    );
  }

  const results = (await Promise.all(tasks)).flat();
  const sorted = results
    .sort((a, b) =>
      relevance(query, a.artist) - relevance(query, b.artist) ||
      SOURCE_ORDER.indexOf((a.source === "mixed" ? "local" : a.source)) - SOURCE_ORDER.indexOf((b.source === "mixed" ? "local" : b.source)) ||
      b.track_count - a.track_count ||
      a.artist.localeCompare(b.artist)
    );
  return mergeArtistResults(sorted, limit);
}

/// "Remix" / "Edit" / "Cover" — typically SoundCloud user uploads, not real albums.
/// We filter at the album level (where these markers usually appear) and rely on
/// album-level title deduplication to keep one canonical track per release.
const ALBUM_NOISE_PATTERNS = [
  /\bremix\b/i,
  /\bremixe(s|d)?\b/i,
  /\bedit\b/i,
  /\bbootleg\b/i,
  /\bmashup\b/i,
  /\bcover\b/i,
  /\bkaraoke\b/i,
  /\binstrumental\b/i,
  /\bsped\s*up\b/i,
  /\bslowed\b/i,
  /\bnightcore\b/i,
  /\btribute\b/i,
  /\b(re|live)-?(record|version|take)\b/i,
];

function isAlbumLikelyRemix(album: string, tracks: Track[]): boolean {
  if (ALBUM_NOISE_PATTERNS.some((re) => re.test(album))) return true;
  // Synthetic "album" that's actually a single SC upload: 1 track AND its title
  // matches the album title (typical "song = album" SC pattern).
  if (tracks.length === 1) {
    const single = tracks[0]!;
    if (normalisedText(single.title) === normalisedText(album)) return true;
    if (ALBUM_NOISE_PATTERNS.some((re) => re.test(single.title))) return true;
  }
  return false;
}

function albumsFromTracks(tracks: Track[]): ArtistAlbum[] {
  // Group across sources by (artist, album) so the same release from SC + VK
  // becomes one album card with combined track count, not two single-track cards.
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const album = track.album?.trim();
    if (!album) continue;
    const key = `${normalisedText(track.artist)}|${normalisedText(album)}`;
    groups.set(key, [...(groups.get(key) ?? []), track]);
  }

  const albums: ArtistAlbum[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const albumName = first.album!.trim();
    const albumSources = SOURCE_ORDER.filter((source) =>
      group.some((track) => track.source === source)
    );
    // Dedupe tracks within an album by title so a track present on both SC + VK
    // counts once. Prefer the source with cover art when available.
    const byTitle = new Map<string, Track>();
    for (const track of group) {
      const titleKey = normalisedText(track.title);
      const existing = byTitle.get(titleKey);
      if (!existing || (!existing.coverUrl && track.coverUrl)) {
        byTitle.set(titleKey, track);
      }
    }
    const uniqueTracks = [...byTitle.values()];
    if (isAlbumLikelyRemix(albumName, uniqueTracks)) continue;

    const primarySource = albumSources.length > 1
      ? "mixed"
      : albumSources[0] ?? (first.source as ArtistSource);

    albums.push({
      album: albumName,
      artist: first.artist,
      track_count: uniqueTracks.length,
      cover_url: uniqueTracks.find((track) => track.coverUrl)?.coverUrl,
      source: primarySource,
    });
  }

  return albums.sort((a, b) =>
    b.track_count - a.track_count ||
    a.album.localeCompare(b.album)
  );
}

function dedupeTracksWithinSources(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const result: Track[] = [];
  for (const track of tracks) {
    // Keep source variants so UI source filters can show the VK/SC/local catalog
    // accurately. Only collapse duplicates inside the same provider.
    const key = `${track.source}|${normalisedText(track.artist)}|${normalisedText(track.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(track);
  }
  return result;
}

export async function getArtistProfile(input: {
  artist: string;
  sources: ArtistSource[];
  sourceId?: string;
  preferredSource?: string;
  limit?: number;
}): Promise<ArtistProfile> {
  const artistName = input.artist.trim();
  const perSourceLimit = Math.max(20, Math.min(input.limit ?? 100, 150));
  const tracksBySource = new Map<ArtistSource, Track[]>();
  const summaries: ArtistResult[] = [];
  const errors: Record<string, string> = {};
  const tasks: Promise<void>[] = [];

  if (input.sources.includes("local")) {
    tasks.push(Promise.resolve().then(() => {
      const tracks = cachedTracksForArtist(artistName, "local", perSourceLimit);
      tracksBySource.set("local", tracks);
      if (tracks.length > 0) {
        summaries.push(summariseTracksAsArtists(tracks, "local", artistName, 1)[0]!);
      }
    }));
  }

  if (input.sources.includes("vk")) {
    tasks.push((async () => {
      try {
        const tracks = getVKProvider().isAuthenticated()
          ? await getVKProvider().getArtistTracks(artistName)
          : cachedTracksForArtist(artistName, "vk", perSourceLimit);
        tracksBySource.set("vk", tracks.slice(0, perSourceLimit));
        if (tracks.length > 0) {
          summaries.push(summariseTracksAsArtists(tracks, "vk", artistName, 1)[0]!);
        }
      } catch (err) {
        errors.vk = err instanceof Error ? err.message : String(err);
        const fallback = cachedTracksForArtist(artistName, "vk", perSourceLimit);
        tracksBySource.set("vk", fallback);
      }
    })());
  }

  if (input.sources.includes("yandex")) {
    tasks.push((async () => {
      try {
        const tracks = getYandexProvider().isAuthenticated()
          ? await getYandexProvider().getArtistTracks(artistName)
          : cachedTracksForArtist(artistName, "yandex", perSourceLimit);
        tracksBySource.set("yandex", tracks.slice(0, perSourceLimit));
        if (tracks.length > 0) {
          summaries.push(summariseTracksAsArtists(tracks, "yandex", artistName, 1)[0]!);
        }
      } catch (err) {
        errors.yandex = err instanceof Error ? err.message : String(err);
        tracksBySource.set("yandex", cachedTracksForArtist(artistName, "yandex", perSourceLimit));
      }
    })());
  }

  if (input.sources.includes("youtube")) {
    tasks.push((async () => {
      try {
        const tracks = await getYouTubeProvider().getArtistTracks(artistName);
        tracksBySource.set("youtube", tracks.slice(0, perSourceLimit));
        if (tracks.length > 0) {
          summaries.push(summariseTracksAsArtists(tracks, "youtube", artistName, 1)[0]!);
        }
      } catch (err) {
        errors.youtube = err instanceof Error ? err.message : String(err);
        tracksBySource.set("youtube", cachedTracksForArtist(artistName, "youtube", perSourceLimit));
      }
    })());
  }

  if (input.sources.includes("soundcloud")) {
    tasks.push((async () => {
      try {
        let sourceId = input.preferredSource === "soundcloud" ? input.sourceId : undefined;
        let artistInfo: ArtistResult | undefined;

        if (!sourceId) {
          const [candidate] = await getSoundCloudProvider().searchArtists(artistName, 1);
          sourceId = candidate?.source_id;
          artistInfo = candidate ? fromSoundCloudArtist(candidate) : undefined;
        }

        if (!sourceId) {
          tracksBySource.set("soundcloud", cachedTracksForArtist(artistName, "soundcloud", perSourceLimit));
          return;
        }

        const [tracks, info] = await Promise.all([
          getSoundCloudProvider().getArtistTracks(sourceId, perSourceLimit),
          artistInfo ? Promise.resolve(artistInfo) : getSoundCloudProvider().getArtistInfo(sourceId).then(fromSoundCloudArtist),
        ]);
        tracksBySource.set("soundcloud", tracks.slice(0, perSourceLimit));
        summaries.push({
          ...info,
          track_count: tracks.length || info.track_count,
          album_count: albumsFromTracks(tracks).filter((album) => album.source === "soundcloud").length,
        });
      } catch (err) {
        errors.soundcloud = err instanceof Error ? err.message : String(err);
        const fallback = cachedTracksForArtist(artistName, "soundcloud", perSourceLimit);
        tracksBySource.set("soundcloud", fallback);
      }
    })());
  }

  await Promise.all(tasks);

  const sourceTracks = SOURCE_ORDER.flatMap((source) => tracksBySource.get(source) ?? []);
  const tracks = dedupeTracksWithinSources(hydrateCachedCoverUrls(
    sourceTracks
  ));
  const albums = albumsFromTracks(tracks);
  const availableSources = SOURCE_ORDER.filter((source) => (tracksBySource.get(source)?.length ?? 0) > 0);
  const preferred = summaries.find((summary) => summary.source === input.preferredSource)
    ?? summaries.find((summary) => summary.cover_url)
    ?? summaries[0];
  const coverUrl = preferred?.cover_url ?? tracks.find((track) => track.coverUrl)?.coverUrl;

  return {
    artist: {
      id: artistId("mixed", artistName, input.sourceId),
      source: "mixed",
      artist: preferred?.artist ?? artistName,
      track_count: tracks.length || preferred?.track_count || 0,
      album_count: albums.length || preferred?.album_count || 0,
      cover_url: coverUrl,
      source_id: input.sourceId ?? preferred?.source_id,
      handle: preferred?.handle,
      subtitle: availableSources.length > 0 ? availableSources.map(sourceLabel).join(" + ") : preferred?.subtitle,
    },
    tracks: tracks.map(normaliseTrackForResponse),
    albums,
    available_sources: availableSources,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  };
}
