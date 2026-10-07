/**
 * Music video matching.
 *
 * Resolves a track to its official music video on YouTube, lazily and cached
 * in the `track_videos` table (migration v26). Fast path: tracks whose source
 * IS youtube already carry the video id in the track id (yt_<videoId>), so no
 * search is needed. Everything else goes through the sidecar's
 * /yt/search-videos (ytmusicapi filter="videos") and a scoring pass that
 * weighs artist/title match and duration proximity.
 */

import { getDb } from "../db/index.js";
import { sidecarGet } from "./sidecar.js";
import { normalizeComparableText } from "../utils/track-identity.js";
import { artistNameMatches } from "./youtube.js";

export interface VideoCandidate {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnailUrl?: string | null;
}

export interface TrackVideoInfo {
  available: boolean;
  videoId?: string;
  title?: string;
  channel?: string;
  duration?: number;
  thumbnailUrl?: string;
}

interface TrackRow {
  id: string;
  source: string;
  title: string;
  artist: string;
  duration: number;
}

/** Max |video.duration − track.duration| for a candidate to stay plausible. */
const MAX_DURATION_DELTA_SEC = 15;

// Title noise typical for video uploads but absent from audio metadata.
const VIDEO_TITLE_NOISE =
  /\b(?:official\s+(?:music\s+)?video|official\s+audio|music\s+video|lyric\s+video|lyrics?|hd|4k|video\s+clip|clip\s+officiel|музыкальн\p{L}*\s+клип|клип|премьера)\b/iu;

function stripVideoTitleNoise(value: string): string {
  const withoutParen = value.replace(/\([^)]*\)|\[[^\]]*]/g, " ");
  const withoutNoise = withoutParen.replace(VIDEO_TITLE_NOISE, " ");
  return normalizeComparableText(withoutNoise);
}

/**
 * Score a YouTube video candidate against a track. Returns -1 when the
 * candidate is unusable, otherwise a 0..100-ish score where ≥ 60 accepts.
 * Exported for tests.
 */
export function scoreVideoCandidate(
  track: { title: string; artist: string; duration: number },
  candidate: VideoCandidate,
): number {
  // Duration is the hardest gate: clips match the song length closely, while
  // wrong matches (live versions, other songs) usually diverge wildly.
  if (track.duration > 0 && candidate.duration > 0) {
    if (Math.abs(candidate.duration - track.duration) > MAX_DURATION_DELTA_SEC) return -1;
  }

  const trackTitle = normalizeComparableText(track.title);
  const videoTitle = stripVideoTitleNoise(candidate.title);
  if (!trackTitle || !videoTitle) return -1;

  // The artist may live in the channel/artists field or only in the title
  // ("Artist — Title" uploads). Check both.
  const artistInField = artistNameMatches(track.artist, candidate.artist);
  const artistTokens = normalizeComparableText(track.artist);
  const artistInTitle =
    !!artistTokens &&
    (normalizeComparableText(candidate.title).includes(artistTokens) ||
      // First credit only: "A feat. B" uploads often list just A.
      artistTokens.split(/\s+/).every((t) => normalizeComparableText(candidate.title).includes(t)));
  if (!artistInField && !artistInTitle) return -1;

  let titleScore = 0;
  if (videoTitle === trackTitle) titleScore = 60;
  else if (videoTitle.includes(trackTitle) || trackTitle.includes(videoTitle)) titleScore = 50;
  else {
    // Token overlap for reordered titles ("song — artist" vs "artist — song").
    const wanted = new Set(trackTitle.split(" ").filter(Boolean));
    const got = new Set(videoTitle.split(" ").filter(Boolean));
    let common = 0;
    for (const t of wanted) if (got.has(t)) common++;
    if (wanted.size === 0 || common < Math.ceil(wanted.size * 0.7)) return -1;
    titleScore = 35;
  }

  let score = titleScore;
  if (artistInField) score += 25;
  if (/\bofficial\b/iu.test(candidate.title) || /\bofficial\b/iu.test(candidate.artist)) score += 10;
  if (track.duration > 0 && candidate.duration > 0) {
    const delta = Math.abs(candidate.duration - track.duration);
    score += delta <= 3 ? 15 : delta <= 8 ? 10 : 5;
  }
  return score;
}

const ACCEPT_SCORE = 60;

/** Pick the best acceptable candidate, or null when nothing clears the bar. */
export function pickBestVideoCandidate(
  track: { title: string; artist: string; duration: number },
  candidates: VideoCandidate[],
): VideoCandidate | null {
  let best: VideoCandidate | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreVideoCandidate(track, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= ACCEPT_SCORE ? best : null;
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getCachedTrackVideo(trackId: string): TrackVideoInfo | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM track_videos WHERE track_id = $id")
    .get({ $id: trackId }) as Record<string, unknown> | null;
  if (!row) return null;
  if (row.status !== "matched" || !row.video_id) return { available: false };
  return {
    available: true,
    videoId: row.video_id as string,
    title: (row.video_title as string | null) ?? undefined,
    channel: (row.channel as string | null) ?? undefined,
    duration: row.duration != null ? Number(row.duration) : undefined,
    thumbnailUrl: (row.thumbnail_url as string | null) ?? undefined,
  };
}

function saveTrackVideo(trackId: string, match: VideoCandidate | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO track_videos (track_id, video_id, video_title, channel, duration, thumbnail_url, status, updated_at)
    VALUES ($id, $vid, $title, $channel, $duration, $thumb, $status, unixepoch())
    ON CONFLICT(track_id) DO UPDATE SET
      video_id = excluded.video_id,
      video_title = excluded.video_title,
      channel = excluded.channel,
      duration = excluded.duration,
      thumbnail_url = excluded.thumbnail_url,
      status = excluded.status,
      updated_at = unixepoch()
  `).run({
    $id: trackId,
    $vid: match?.videoId ?? null,
    $title: match?.title ?? null,
    $channel: match?.artist ?? null,
    $duration: match?.duration ?? null,
    $thumb: match?.thumbnailUrl ?? null,
    $status: match ? "matched" : "none",
  });
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Find (and persist) the music video for a track row from `tracks`.
 * Returns the match info; `available:false` means "we looked, nothing found"
 * and is cached just like a positive match.
 */
export async function matchTrackVideo(track: TrackRow): Promise<TrackVideoInfo> {
  // Fast path: a youtube-sourced track IS a video already.
  if (track.source === "youtube" && track.id.startsWith("yt_")) {
    const videoId = track.id.slice(3);
    const match: VideoCandidate = {
      videoId,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
    };
    saveTrackVideo(track.id, match);
    return {
      available: true,
      videoId,
      title: track.title,
      channel: track.artist,
      duration: track.duration,
    };
  }

  const query = `${track.artist} ${track.title} official music video`;
  const { videos } = await sidecarGet<{ videos: VideoCandidate[] }>(
    `/yt/search-videos?q=${encodeURIComponent(query)}&count=10`,
  );
  const best = pickBestVideoCandidate(track, videos ?? []);
  saveTrackVideo(track.id, best);
  if (!best) return { available: false };
  return {
    available: true,
    videoId: best.videoId,
    title: best.title,
    channel: best.artist,
    duration: best.duration,
    thumbnailUrl: best.thumbnailUrl ?? undefined,
  };
}

/** Resolve a playable muxed (audio+video) URL for a video via yt-dlp. */
export async function resolveVideoStreamUrl(
  videoId: string,
): Promise<{ url: string; expiresAt: number | null; duration: number }> {
  const res = await sidecarGet<{ url: string; duration?: number }>(
    `/yt/video-stream/${encodeURIComponent(videoId)}`,
  );
  if (!res.url) throw new Error(`No video stream for ${videoId}`);
  // googlevideo URLs carry an `expire` epoch query param; surface it so the
  // client can re-resolve proactively instead of after a mid-playback 403.
  let expiresAt: number | null = null;
  try {
    const expire = new URL(res.url).searchParams.get("expire");
    if (expire && /^\d+$/.test(expire)) expiresAt = Number(expire);
  } catch {
    // Non-URL-shaped value — treat as non-expiring.
  }
  return { url: res.url, expiresAt, duration: Number(res.duration ?? 0) };
}
