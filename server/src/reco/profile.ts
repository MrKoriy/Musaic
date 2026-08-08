/**
 * Taste Engine — ML-like taste profiling from listening history.
 *
 * Computes weighted scores for artists, genres, moods based on:
 *   - Action type: complete > like > play > skip
 *   - Recency: recent listens weighted higher (exponential decay over 30 days)
 *   - Frequency: more listens = higher score
 *   - Time-of-day context for recommendations
 */

import { getDb } from "../db/index.js";
import { songFamilyKey } from "../utils/track-identity.js";
import { canonicalizeTag } from "../reco/tags.js";
import {
  clearCached as clearSharedCached,
  clearCachedWhere as clearSharedCachedWhere,
  clearInFlightWhere,
  getCached as getSharedCached,
  getCacheSize as getSharedCacheSize,
  getInFlightSize as getSharedInFlightSize,
  getOrSetCached as getSharedOrSetCached,
  invalidateAllCaches as invalidateSharedCaches,
  setCached as setSharedCached,
} from "../utils/cache.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TasteProfile {
  topArtists: Array<{ artist: string; score: number }>;
  topTracks: Array<{ id: string; artist: string; title: string; score: number }>;
  topGenres: Array<{ genre: string; score: number }>;
  topMoods: Array<{ mood: string; score: number }>;
  playCount: number;
  completionRate: number;
  timeOfDayProfile: TimeOfDayProfile;
}

interface TimeOfDayProfile {
  morning: string[];   // 6-12h — artist names for this time slot
  afternoon: string[]; // 12-18h
  evening: string[];   // 18-22h
  night: string[];     // 22-6h
}

// ─── Scoring constants ─────────────────────────────────────────────────────────

function actionWeight(action: string, playedRatio: number | null): number {
  switch (action) {
    case "like": return 3;
    case "unlike": return -3;
    case "complete": return 2.2;
    case "play": return playedRatio == null ? 1 : 0.4 + Math.min(playedRatio, 1) * 1.6;
    case "skip":
      // A skip is primarily session feedback. Only a very early skip is a
      // strong negative; advancing near the end is weakly positive.
      if (playedRatio == null || playedRatio < 0.1) return -1.8;
      if (playedRatio < 0.25) return -1.1;
      if (playedRatio < 0.5) return -0.4;
      return 0.25;
    case "dislike": return -4;
    case "pause": return 0;
    default: return 0;
  }
}

const DECAY_HALF_LIFE_DAYS = 14; // Listens from 14 days ago are worth half as much
const LOG_BASE = Math.LN2 / (DECAY_HALF_LIFE_DAYS * 86400);

function recencyScore(playedAtSec: number): number {
  const ageSec = Date.now() / 1000 - playedAtSec;
  return Math.exp(-LOG_BASE * Math.max(0, ageSec));
}

// ─── Recommendation cache ─────────────────────────────────────────────────────

export const RECOMMENDATION_CACHE_VERSION = "phase2-v1";
let observedCacheVersionDb: unknown = null;

/** Clear stale in-memory entries when the persisted algorithm version changes. */
function ensureRecommendationCacheVersion(): void {
  const db = getDb();
  if (observedCacheVersionDb === db) return;

  try {
    const row = db.prepare("SELECT value FROM reco_settings WHERE key = $key")
      .get({ $key: "RECOMMENDATION_CACHE_VERSION" }) as { value: string } | null;
    if (row?.value !== RECOMMENDATION_CACHE_VERSION) {
      invalidateSharedCaches();
      db.prepare(`
        INSERT INTO reco_settings (key, value, updated_at)
        VALUES ($key, $value, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
      `).run({ $key: "RECOMMENDATION_CACHE_VERSION", $value: RECOMMENDATION_CACHE_VERSION });
    }
  } catch {
    // Older test databases may not have recommendation settings yet.
  }
  observedCacheVersionDb = db;
}

export function getCached<T>(key: string): T | null {
  ensureRecommendationCacheVersion();
  return getSharedCached<T>(key);
}

export function setCached(key: string, data: unknown, ttlMs?: number): void {
  ensureRecommendationCacheVersion();
  setSharedCached(key, data, ttlMs);
}

export function clearCached(key: string): void {
  clearSharedCached(key);
}

export function getOrSetCached<T>(key: string, factory: () => Promise<T> | T, ttlMs?: number): Promise<T> {
  ensureRecommendationCacheVersion();
  return getSharedOrSetCached(key, factory, ttlMs);
}

export function getCacheSize(): number {
  return getSharedCacheSize();
}

export function getInFlightSize(): number {
  return getSharedInFlightSize();
}

export function invalidateAllCaches(): void {
  invalidateSharedCaches();
  observedCacheVersionDb = null;
}

export function userCacheKey(key: string, userId?: string | null): string {
  return `${key}:user:${userId ?? "anonymous"}`;
}

export function clearUserRecommendationCaches(userId?: string | null): void {
  ensureRecommendationCacheVersion();
  const userKey = userId ?? "anonymous";
  for (const key of ["home", "taste-profile", "discover", "daily-mix"]) {
    clearCached(userCacheKey(key, userId));
  }

  // Warm catalog entries include a hashed user scope, so clear the warm
  // namespace as a whole. Daily Mix delivery itself is persisted in SQLite and
  // remains stable for the current calendar day.
  clearSharedCachedWhere((key) => key.startsWith("catalog-warm:"));
  clearInFlightWhere((key) => key.startsWith("catalog-warm:") || key.includes(`user:${userKey}`));
}

// ─── Taste engine ─────────────────────────────────────────────────────────────

/**
 * Build a weighted taste profile from listening history.
 */
export function buildWeightedProfile(userId: string | null = null): TasteProfile {
  const db = getDb();

  // Fetch listening history with track metadata (last 90 days)
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
  const history = db.prepare(`
    SELECT * FROM (
      SELECT lh.action, lh.played_at, lh.played_ratio,
             t.id as track_id, t.artist, t.title, t.genre, t.mood
      FROM listening_history lh
      JOIN tracks t ON lh.track_id = t.id
      WHERE lh.played_at > $cutoff
        AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))

      UNION ALL

      SELECT 'like' AS action,
             MAX(lt.liked_at, unixepoch() - 7 * 86400) AS played_at,
             NULL AS played_ratio,
             t.id AS track_id, t.artist, t.title, t.genre, t.mood
      FROM liked_tracks lt
      JOIN tracks t ON lt.track_id = t.id
      WHERE lt.user_id = $userId
        AND NOT EXISTS (
          SELECT 1 FROM listening_history lh
          WHERE lh.track_id = lt.track_id
            AND lh.action = 'like'
            AND lh.played_at > $cutoff
            AND lh.user_id = $userId
        )
    )
    ORDER BY played_at DESC
    LIMIT 10000
  `).all({ $cutoff: cutoff, $userId: userId }) as Array<{
    action: string;
    played_at: number;
    played_ratio: number | null;
    track_id: string;
    artist: string;
    title: string;
    genre: string | null;
    mood: string | null;
  }>;

  const artistScores = new Map<string, number>();
  const trackScores = new Map<string, { id: string; artist: string; title: string; score: number }>();
  const genreScores = new Map<string, number>();
  const moodScores = new Map<string, number>();

  // Time-of-day: count plays per artist per time slot
  const timeSlots = { morning: new Map<string, number>(), afternoon: new Map<string, number>(), evening: new Map<string, number>(), night: new Map<string, number>() };

  let totalPlays = 0;
  let totalCompletes = 0;

  for (const event of history) {
    const weight = actionWeight(event.action, event.played_ratio);
    if (weight === 0) continue;

    const recency = recencyScore(event.played_at);
    const score = weight * recency;

    // Artist & track scores also absorb NEGATIVE signals: a skip (-0.5) or
    // dislike (-2.0) actively pushes the performer down, so an artist the user
    // keeps skipping stops ranking as a "favorite".
    // Removing a like reverses preference for the track but is not evidence
    // that the user dislikes the whole artist.
    const artistScore = event.action === "unlike" ? 0 : score;
    artistScores.set(event.artist, (artistScores.get(event.artist) ?? 0) + artistScore);

    // Track score
    const trackKey = event.track_id;
    const existing = trackScores.get(trackKey);
    if (existing) {
      existing.score += score;
    } else {
      trackScores.set(trackKey, { id: event.track_id, artist: event.artist, title: event.title, score });
    }

    // Genres, moods and time-of-day context accumulate positive signal only —
    // one skipped track shouldn't brand a whole genre as disliked.
    if (weight > 0) {
      // Genre score
      if (event.genre) {
        for (const g of event.genre.split(",").map((s) => s.trim())) {
          if (g) genreScores.set(g, (genreScores.get(g) ?? 0) + score);
        }
      }

      // Mood score
      if (event.mood) {
        for (const m of event.mood.split(",").map((s) => s.trim())) {
          if (m) moodScores.set(m, (moodScores.get(m) ?? 0) + score);
        }
      }

      // Time of day (using played_at as local time approximation)
      const hour = new Date(event.played_at * 1000).getHours();
      const slot =
        hour >= 6 && hour < 12 ? "morning" :
        hour >= 12 && hour < 18 ? "afternoon" :
        hour >= 18 && hour < 22 ? "evening" : "night";
      const slotMap = timeSlots[slot];
      slotMap.set(event.artist, (slotMap.get(event.artist) ?? 0) + score);
    }

    const ratio = event.played_ratio ?? 0;
    const isLegacyPlay = event.action === "play" && event.played_ratio == null;
    const isRichQualifiedListen = event.played_ratio != null &&
      ["play", "complete", "skip"].includes(event.action) && ratio >= 0.5;
    if (isLegacyPlay || isRichQualifiedListen) {
      totalPlays++;
    }
    if (event.action === "complete" || ratio >= 0.9) totalCompletes++;
  }

  // Sort by score (descending); drop anything with a net-negative score.
  const topArtists = [...artistScores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([artist, score]) => ({ artist, score }));

  const topTracks = [...trackScores.values()]
    .filter((track) => track.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  const topGenres = [...genreScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([genre, score]) => ({ genre, score }));

  const topMoods = [...moodScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([mood, score]) => ({ mood, score }));

  // Top 3 artists per time slot
  function topForSlot(slotMap: Map<string, number>): string[] {
    return [...slotMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);
  }

  return {
    topArtists,
    topTracks,
    topGenres,
    topMoods,
    playCount: totalPlays,
    completionRate: totalPlays > 0 ? Math.min(1, totalCompletes / totalPlays) : 0,
    timeOfDayProfile: {
      morning: topForSlot(timeSlots.morning),
      afternoon: topForSlot(timeSlots.afternoon),
      evening: topForSlot(timeSlots.evening),
      night: topForSlot(timeSlots.night),
    },
  };
}

/**
 * Get time-of-day appropriate artist suggestions.
 */
export function getTimeContextArtists(profile: TasteProfile): string[] {
  const hour = new Date().getHours();
  const slot =
    hour >= 6 && hour < 12 ? "morning" :
    hour >= 12 && hour < 18 ? "afternoon" :
    hour >= 18 && hour < 22 ? "evening" : "night";

  const slotArtists = profile.timeOfDayProfile[slot];
  if (slotArtists.length > 0) return slotArtists;

  // Fallback to overall top artists
  return profile.topArtists.slice(0, 3).map((a) => a.artist);
}

/**
 * VK is excluded from all discovery/recommendation surfaces — its audio API is
 * dead for new tracks, so we never want to suggest a VK track the user can't
 * reliably stream. Already-liked VK tracks remain in the library and still play
 * (the stream proxy keeps a VK branch); they're just never surfaced as picks.
 */
export function isDiscoverableRow(row: { source?: unknown }): boolean {
  return row.source !== "vk";
}

/**
 * Build a Daily Mix playlist (20 tracks) from taste profile.
 * Mixes top favorites with some discovery candidates.
 */
export function buildDailyMix(
  profile: TasteProfile,
  discoverArtists: string[] = [],
  userId: string | null = null,
  orderingSeed?: string
): Array<Record<string, unknown>> {
  const db = getDb();

  const contextArtists = getTimeContextArtists(profile);
  const topArtistNames = profile.topArtists.slice(0, 8).map((a) => a.artist);

  // Mix: 70% favorites, 30% discovery
  const favoriteArtists = [...new Set([...contextArtists, ...topArtistNames])];
  const candidates: Record<string, unknown>[] = [];

  const nowSec = Math.floor(Date.now() / 1000);
  const recentPlayCutoff = nowSec - 7 * 86400;  // don't repeat last week's plays
  const recentSkipCutoff = nowSec - 3 * 86400;  // don't offer recently skipped songs
  const recentDislikeCutoff = nowSec - 30 * 86400;

  // Favorites: pick less-recently-played tracks, excluding anything the user
  // skipped in the last few days — a skip is a "not this song" signal.
  for (const artist of favoriteArtists.slice(0, 6)) {
    const rows = db.prepare(`
      SELECT t.* FROM tracks t
      WHERE lower(t.artist) LIKE lower($a)
        AND t.id NOT IN (
          SELECT lh.track_id FROM listening_history lh
          WHERE lh.played_at > $recentPlay AND lh.action IN ('play', 'complete')
            AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))
        )
         AND t.id NOT IN (
           SELECT lh.track_id FROM listening_history lh
           WHERE lh.played_at > $recentSkip AND lh.action = 'skip'
             AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))
         )
         AND NOT EXISTS (
           SELECT 1 FROM listening_history disliked
           WHERE disliked.track_id = t.id
             AND disliked.action = 'dislike'
             AND disliked.played_at > $recentDislike
             AND (disliked.user_id = $userId OR (disliked.user_id IS NULL AND $userId IS NULL))
             AND NOT EXISTS (
               SELECT 1 FROM listening_history liked
               WHERE liked.track_id = disliked.track_id
                 AND liked.action = 'like'
                 AND liked.played_at > disliked.played_at
                 AND (liked.user_id = $userId OR (liked.user_id IS NULL AND $userId IS NULL))
             )
         )
         ORDER BY t.id
      LIMIT 60
    `).all({
      $a: `%${artist}%`,
      $recentPlay: recentPlayCutoff,
      $recentSkip: recentSkipCutoff,
      $recentDislike: recentDislikeCutoff,
      $userId: userId,
    }) as Record<string, unknown>[];

    // Fallback: any track from this artist — a recently PLAYED track is fine
    // to repeat, but a recently SKIPPED one is a hard "no".
    const available = rows.length > 0 ? rows : db.prepare(`
      SELECT t.* FROM tracks t
      WHERE lower(t.artist) LIKE lower($a)
        AND t.id NOT IN (
          SELECT lh.track_id FROM listening_history lh
          WHERE lh.played_at > $recentSkip AND lh.action = 'skip'
            AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))
        )
        AND NOT EXISTS (
          SELECT 1 FROM listening_history disliked
          WHERE disliked.track_id = t.id
            AND disliked.action = 'dislike'
            AND disliked.played_at > $recentDislike
            AND (disliked.user_id = $userId OR (disliked.user_id IS NULL AND $userId IS NULL))
            AND NOT EXISTS (
              SELECT 1 FROM listening_history liked
              WHERE liked.track_id = disliked.track_id
                AND liked.action = 'like'
                AND liked.played_at > disliked.played_at
                AND (liked.user_id = $userId OR (liked.user_id IS NULL AND $userId IS NULL))
            )
        )
        ORDER BY t.id
      LIMIT 60
    `).all({ $a: `%${artist}%`, $recentSkip: recentSkipCutoff, $recentDislike: recentDislikeCutoff, $userId: userId }) as Record<string, unknown>[];

    candidates.push(...(orderingSeed
      ? deterministicOrder(available, `${orderingSeed}:favorite:${artist}`).slice(0, rows.length > 0 ? 3 : 2)
      : shuffled(available).slice(0, rows.length > 0 ? 3 : 2)));
  }

  // Discovery: tracks from similar artists not in library top — also avoiding
  // songs already played or skipped in the last 3 days.
  const discoverCutoff = nowSec - 3 * 86400;
  for (const artist of discoverArtists.slice(0, 4)) {
    const rows = db.prepare(`
      SELECT t.* FROM tracks t
      WHERE lower(t.artist) LIKE lower($a)
        AND t.id NOT IN (
          SELECT lh.track_id FROM listening_history lh
          WHERE lh.played_at > $recent AND lh.action IN ('play', 'complete', 'skip')
            AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))
        )
      ORDER BY t.id
      LIMIT 60
    `).all({
      $a: `%${artist}%`,
      $recent: discoverCutoff,
      $userId: userId,
    }) as Record<string, unknown>[];
    candidates.push(...(orderingSeed
      ? deterministicOrder(rows, `${orderingSeed}:discover:${artist}`).slice(0, 2)
      : shuffled(rows).slice(0, 2)));
  }

  // Deduplicate by id AND by normalized artist+title — the same song cached
  // from several sources (local + yandex + youtube) gets different ids, and a
  // "mix" with the same track twice looks broken.
  const seen = new Set<string>();
  const seenSongs = new Set<string>();
  const deduped = candidates.filter((t) => {
    if (!isDiscoverableRow(t)) return false;
    const id = t.id as string;
    const songKey = songFamilyKey({
      artist: String(t.artist ?? ""),
      title: String(t.title ?? ""),
    });
    if (seen.has(id) || seenSongs.has(songKey)) return false;
    seen.add(id);
    seenSongs.add(songKey);
    return true;
  });

  return (orderingSeed ? deterministicOrder(deduped, orderingSeed) : shuffled(deduped)).slice(0, 20);
}

// Maps mood labels (used in the app UI) to related genre/keyword synonyms for
// broader DB matching. Covers both English mood labels from HomeView and common
// music genre terms that may appear in track genre/title/artist fields.
const MOOD_KEYWORDS: Record<string, string[]> = {
  energise:  ["electronic", "dance", "hip hop", "hip-hop", "rap", "edm", "pop", "rock", "trap", "drill"],
  energy:    ["electronic", "dance", "hip hop", "hip-hop", "rap", "edm", "pop", "rock", "trap", "drill"],
  "feel good": ["pop", "funk", "soul", "indie", "disco", "r&b", "happy"],
  feelgood:  ["pop", "funk", "soul", "indie", "disco", "r&b", "happy"],
  relax:     ["ambient", "chill", "lofi", "lo-fi", "jazz", "acoustic", "downtempo", "chillout"],
  workout:   ["hip hop", "hip-hop", "rap", "rock", "metal", "electronic", "edm", "drum"],
  sad:       ["sad", "blues", "emo", "acoustic", "slow", "melancholy", "indie"],
  party:     ["dance", "house", "club", "edm", "hip hop", "pop", "techno", "trance"],
  focus:     ["ambient", "classical", "instrumental", "electronic", "lofi", "lo-fi", "piano"],
  romance:   ["r&b", "soul", "love", "ballad", "slow", "jazz", "rnb"],
  romantic:  ["r&b", "soul", "love", "ballad", "slow", "jazz", "rnb"],
  sleep:     ["ambient", "classical", "acoustic", "piano", "meditation", "downtempo", "chill"],
};

/**
 * Get tracks matching a mood tag.
 * 1. Exact keyword match on mood/genre/title/artist/album fields.
 * 2. Expanded genre-keyword search using the MOOD_KEYWORDS mapping.
 * 3. Taste-profile fallback: tracks from the user's top listened artists
 *    (personalized and varied per mood via shuffle seed offset).
 * 4. Final fallback: random tracks from DB.
 */
export function getTracksByMood(mood: string, limit = 20, userId: string | null = null): Record<string, unknown>[] {
  const db = getDb();
  const moodLower = mood.toLowerCase().trim();
  const disliked = db.prepare(`
    SELECT t.artist, t.title, lh.played_at
    FROM listening_history lh JOIN tracks t ON t.id = lh.track_id
    WHERE lh.action = 'dislike' AND lh.played_at >= unixepoch() - 30 * 86400
      AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))
      AND NOT EXISTS (
        SELECT 1 FROM listening_history liked
        WHERE liked.track_id = lh.track_id AND liked.action = 'like'
          AND liked.played_at > lh.played_at
          AND (liked.user_id = $userId OR (liked.user_id IS NULL AND $userId IS NULL))
      )
  `).all({ $userId: userId }) as Array<{ artist: string; title: string }>;
  const dislikedFamilies = new Set(disliked.map((row) => songFamilyKey(row)));
  const allowed = (row: Record<string, unknown>) => isDiscoverableRow(row) && !dislikedFamilies.has(songFamilyKey({
    artist: String(row.artist ?? ""), title: String(row.title ?? ""),
  }));

  // 1. Exact keyword search
  const exact = (db.prepare(`
    SELECT * FROM tracks
    WHERE lower(mood) LIKE lower($mood)
       OR lower(genre) LIKE lower($mood)
       OR lower(title) LIKE lower($mood)
       OR lower(artist) LIKE lower($mood)
       OR lower(album) LIKE lower($mood)
    ORDER BY RANDOM()
    LIMIT $limit
  `).all({ $mood: `%${moodLower}%`, $limit: limit }) as Record<string, unknown>[]).filter(allowed);

  if (exact.length >= limit) return exact;

  const seen = new Set<string>(exact.map((t) => t.id as string));
  const combined: Record<string, unknown>[] = [...exact];

  // 2. Expanded genre/keyword search
  const synonyms = MOOD_KEYWORDS[moodLower] ?? [];
  for (const kw of synonyms) {
    if (combined.length >= limit) break;
    const rows = db.prepare(`
      SELECT * FROM tracks
      WHERE lower(genre) LIKE lower($kw)
         OR lower(mood) LIKE lower($kw)
      ORDER BY RANDOM()
      LIMIT $lim
    `).all({ $kw: `%${kw}%`, $lim: limit - combined.length }) as Record<string, unknown>[];
    for (const row of rows) {
      if (allowed(row) && !seen.has(row.id as string)) {
        seen.add(row.id as string);
        combined.push(row);
      }
    }
  }

  const canonicalMood = canonicalizeTag(moodLower);
  if (canonicalMood && combined.length < limit) {
    const rows = db.prepare(`
      SELECT DISTINCT t.* FROM tracks t JOIN track_tags tt ON tt.track_id = t.id
      WHERE lower(tt.tag) = lower($tag)
      ORDER BY t.play_count DESC, t.updated_at DESC LIMIT $limit
    `).all({ $tag: canonicalMood, $limit: limit - combined.length }) as Record<string, unknown>[];
    for (const row of rows) {
      if (allowed(row) && !seen.has(row.id as string)) {
        seen.add(row.id as string);
        combined.push(row);
      }
    }
  }

  if (combined.length >= limit) return combined.slice(0, limit);

  // 3. Taste-profile fallback: tracks from top listened artists
  try {
    const profile = buildWeightedProfile(userId);
    const topArtists = profile.topArtists.slice(0, 12).map((a) => a.artist);
    // Use a different offset per mood so different moods return different artists
    const offset = Math.abs(moodLower.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0)) % Math.max(1, topArtists.length);
    const orderedArtists = [...topArtists.slice(offset), ...topArtists.slice(0, offset)];

    for (const artist of orderedArtists) {
      if (combined.length >= limit) break;
      const rows = db.prepare(`
        SELECT * FROM tracks
        WHERE lower(artist) LIKE lower($a)
        ORDER BY RANDOM()
        LIMIT $lim
      `).all({ $a: `%${artist}%`, $lim: limit - combined.length }) as Record<string, unknown>[];
      for (const row of rows) {
        if (allowed(row) && !seen.has(row.id as string)) {
          seen.add(row.id as string);
          combined.push(row);
        }
      }
    }
  } catch { /* no history yet — proceed to final fallback */ }

  if (combined.length >= Math.min(limit, 5)) return shuffled(combined).slice(0, limit);

  // 4. Final fallback: random tracks
  const fallback = db.prepare(`SELECT * FROM tracks ORDER BY RANDOM() LIMIT $limit`)
    .all({ $limit: limit - combined.length }) as Record<string, unknown>[];
  for (const row of fallback) {
    if (allowed(row) && !seen.has(row.id as string)) combined.push(row);
  }
  return shuffled(combined).slice(0, limit);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicOrder<T extends Record<string, unknown>>(items: T[], seed: string): T[] {
  return [...items].sort((left, right) => {
    const leftKey = `${seed}:${String(left.id ?? "")}`;
    const rightKey = `${seed}:${String(right.id ?? "")}`;
    return stableHash(leftKey) - stableHash(rightKey) || leftKey.localeCompare(rightKey);
  });
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
