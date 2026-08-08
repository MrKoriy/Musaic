/**
 * Recommendation candidate generation and ranking.
 */

import { getDb } from "../db/index.js";
import {
  buildWeightedProfile,
  buildDailyMix,
  getTimeContextArtists,
  getCached,
  setCached,
  isDiscoverableRow,
} from "./profile.js";
import { getYandexProvider } from "../providers/yandex.js";
import { getYouTubeProvider } from "../providers/youtube.js";
import { getSoundCloudProvider } from "../providers/soundcloud.js";
import { relatedArtistKeys } from "../jobs/similar-items.js";
import { canonicalizeTag } from "../reco/tags.js";
import {
  loadLatestRecoModel,
  predictRecoModel,
  vectorFromFeatures,
  type RecoFeatureVector,
} from "../reco/ranker.js";
import { cosineSimilarity, decodeEmbedding } from "../reco/audio.js";
import crypto from "crypto";
import {
  baseTrackTitle,
  normalizeArtistIdentity,
  songFamilyKey,
  trackVariantPenalty,
} from "../utils/track-identity.js";
import { getOrCreateInFlight } from "../utils/cache.js";

const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";
function safeScope(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function yandexWaveCacheKey(userId: string | null): string {
  const provider = getYandexProvider();
  return `catalog-warm:yandex-wave:${safeScope(`${userId ?? "anonymous"}:${provider.getUsername() ?? "unconfigured"}`)}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getLastfmKey(): string | null {
  return process.env.LASTFM_API_KEY ?? null;
}

async function lastfmGet(params: Record<string, string>): Promise<unknown> {
  const key = getLastfmKey();
  if (!key) throw new Error("LASTFM_API_KEY not set");
  const q = new URLSearchParams({ ...params, api_key: key, format: "json" });
  const res = await fetch(`${LASTFM_BASE}?${q}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Last.fm error: ${res.status}`);
  return res.json();
}

export interface VibeSeed {
  id?: string;
  artist?: string;
  title?: string;
  album?: string;
  source?: string;
}

interface VibeMetadataRow {
  genre: string | null;
  mood: string | null;
}

export interface VibeFilters {
  language?: "russian" | "foreign";
  character?: "favorite" | "unfamiliar" | "popular";
  mood?: string;
}

export interface VibeTrackRow extends Record<string, unknown> {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  mood: string | null;
  play_count: number;
  last_played_at: number | null;
  updated_at: number | null;
  source: string;
}

interface RankedVibeCandidate {
  row: VibeTrackRow;
  baseScore: number;
  signalCount: number;
}

interface UserTrackStats {
  positiveCount: number;
  earlySkipCount: number;
  lastPlayedAt: number | null;
  lastSkippedAt: number | null;
  lastDislikedAt: number | null;
  lastLikedAt: number | null;
}

interface UserArtistStats {
  positiveCount: number;
  earlySkipCount: number;
  dislikeCount: number;
  likeCount: number;
  lastDislikedAt: number | null;
}

interface SimilarTrackSignal {
  artist: string;
  title: string;
  match: number;
}

interface SessionOutcome extends VibeSeed {
  action?: "skip" | "complete" | "play" | "like" | "dislike";
  completionRatio?: number;
}

export interface StationSessionContext {
  sessionId?: string;
  recentOutcomes: SessionOutcome[];
  queueTail: VibeSeed[];
  skipStreak: number;
  enabledSources: Set<string>;
  rapidSkip: boolean;
  acceptedSeeds: VibeSeed[];
  skippedArtists: Map<string, number>;
  reactionRefresh: boolean;
}

type StationMode = "my_vibe" | "auto_mix";

const VIBE_STOP_WORDS = new Set([
  "feat", "ft", "and", "the", "with", "prod", "edit", "version", "mix",
  "radio", "remix", "demo", "song", "track", "official", "audio", "music",
  "from", "что", "как", "это", "она", "они", "или", "для", "feat.", "prod.",
]);
const VIBE_CYRILLIC_RE = /[А-Яа-яЁё]/u;
const VIBE_MOOD_ALIASES: Record<string, string[]> = {
  energy: ["energy", "energise", "energetic", "workout", "gym", "power", "dance", "бодро", "энергия", "заряд", "тренировка"],
  energise: ["energy", "energise", "energetic", "edm", "dance", "rock", "rap", "power", "бодро", "энергия", "заряд"],
  feelgood: ["feel good", "feelgood", "happy", "sunny", "bright", "positive", "светло", "радость", "позитив"],
  calm: ["relax", "calm", "chill", "sleep", "ambient", "спокойно", "сон", "тихо", "мягко"],
  relax: ["relax", "calm", "chill", "ambient", "downtempo", "acoustic", "jazz", "спокойно", "тихо", "мягко"],
  workout: ["workout", "gym", "energy", "hip hop", "rap", "rock", "metal", "edm", "drum", "тренировка", "спорт"],
  focus: ["focus", "study", "work", "deep", "concentration", "фокус", "учеба", "работа", "концентрация"],
  romance: ["romance", "romantic", "love", "date", "романтика", "любовь"],
  sad: ["sad", "melancholy", "cry", "грусть", "меланхолия", "печаль"],
  party: ["party", "club", "dance", "вечеринка", "клуб", "танцы"],
  sleep: ["sleep", "ambient", "classical", "piano", "meditation", "downtempo", "chill", "сон", "тихо"],
  night: ["night", "late night", "midnight", "afterhours", "ночь", "поздний вечер"],
};

function uniqueStrings(values: Array<string | null | undefined>, limit = 12): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function splitTagField(value: string | null | undefined): string[] {
  return uniqueStrings((value ?? "").split(",").map((item) => item.trim()).filter(Boolean), 10);
}

export function normalizePhrase(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeMoodKey(value: string | null | undefined): string {
  return normalizePhrase(value).replace(/[\s_-]+/g, "");
}

function expandMoodTerms(value: string | null | undefined): string[] {
  const normalized = normalizeMoodKey(value);
  if (!normalized) return [];
  return uniqueStrings(
    [value ?? "", ...(VIBE_MOOD_ALIASES[normalized] ?? [])].map((term) => normalizePhrase(term)),
    16
  ).filter(Boolean);
}

function extractVibeKeywords(values: Array<string | null | undefined>, limit = 12): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const value of values) {
    const parts = (value ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4 && !VIBE_STOP_WORDS.has(item));
    for (const part of parts) {
      if (seen.has(part)) continue;
      seen.add(part);
      keywords.push(part);
      if (keywords.length >= limit) return keywords;
    }
  }
  return keywords;
}


export function sanitizeSeed(value: unknown): VibeSeed | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const clean = (key: string, max: number) => typeof item[key] === "string" ? String(item[key]).trim().slice(0, max) : undefined;
  const seed: VibeSeed = {
    id: clean("id", 160), artist: clean("artist", 160), title: clean("title", 240),
    album: clean("album", 240), source: clean("source", 32),
  };
  return seed.id || (seed.artist && seed.title) ? seed : null;
}

export function parseStationSession(body: Record<string, unknown>): StationSessionContext {
  const allowedActions = new Set(["skip", "complete", "play", "like", "dislike"]);
  const recentOutcomes = (Array.isArray(body.recentOutcomes) ? body.recentOutcomes : []).slice(-20).flatMap((raw) => {
    const seed = sanitizeSeed(raw);
    if (!seed || !raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const action = typeof item.action === "string" && allowedActions.has(item.action) ? item.action as SessionOutcome["action"] : undefined;
    const rawRatio = Number(item.completionRatio);
    const completionRatio = Number.isFinite(rawRatio) ? Math.max(0, Math.min(rawRatio, 1)) : undefined;
    return [{ ...seed, action, completionRatio }];
  });
  const queueTail = (Array.isArray(body.queueTail) ? body.queueTail : []).slice(-12).flatMap((raw) => {
    const seed = sanitizeSeed(raw); return seed ? [seed] : [];
  });
  const recentFive = recentOutcomes.slice(-5);
  const rapidSkip = recentFive.filter((item) => item.action === "skip" && (item.completionRatio ?? 0) < 0.25).length >= 3;
  const acceptedSeeds = recentOutcomes.filter((item) =>
    item.action === "complete" || item.action === "like" || ((item.action === "play" || item.action === "skip") && (item.completionRatio ?? 0) >= 0.5)
  ).slice(-6);
  const skippedArtists = new Map<string, number>();
  for (const item of recentOutcomes) {
    if (item.action !== "skip" || (item.completionRatio ?? 0) >= 0.25 || !item.artist) continue;
    const key = normalizeArtistIdentity(item.artist);
    skippedArtists.set(key, (skippedArtists.get(key) ?? 0) + 1);
  }
  const requestedSources = Array.isArray(body.enabledSources) ? body.enabledSources : undefined;
  const enabledSources = new Set((requestedSources ?? ["local", "yandex", "youtube", "soundcloud"])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => ["local", "yandex", "youtube", "soundcloud"].includes(value)));
  enabledSources.delete("vk");
  if (enabledSources.size === 0) enabledSources.add("local");
  return {
    sessionId: typeof body.sessionId === "string" ? body.sessionId.trim().slice(0, 128) || undefined : undefined,
    recentOutcomes, queueTail,
    skipStreak: Math.max(0, Math.min(Number.isFinite(Number(body.skipStreak)) ? Math.floor(Number(body.skipStreak)) : 0, 20)),
    enabledSources, rapidSkip, acceptedSeeds, skippedArtists,
    reactionRefresh: body.reactionRefresh === true,
  };
}

export function normalizeTrackRow(row: Record<string, unknown>): VibeTrackRow {
  return {
    ...row,
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    artist: String(row.artist ?? ""),
    album: typeof row.album === "string" ? row.album : null,
    genre: typeof row.genre === "string" ? row.genre : null,
    mood: typeof row.mood === "string" ? row.mood : null,
    play_count: Number(row.play_count ?? 0) || 0,
    last_played_at: row.last_played_at == null ? null : Number(row.last_played_at),
    updated_at: row.updated_at == null ? null : Number(row.updated_at),
    source: String(row.source ?? "local"),
  };
}

function normalizeArtistKey(value: string | null | undefined): string {
  return normalizePhrase(value).replace(/\s+/g, " ").trim();
}

function normalizeTitleKey(value: string | null | undefined): string {
  return normalizePhrase(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function canonicalSongKey(row: Pick<VibeTrackRow, "artist" | "title">): string {
  return songFamilyKey(row);
}

export function collapseTrackVariants<T extends Record<string, unknown>>(tracks: T[]): T[] {
  const seenIds = new Set<string>();
  const seenFamilies = new Set<string>();
  const baseTitleVariantState = new Map<string, boolean>();

  return tracks.filter((track) => {
    const id = String(track.id ?? "").trim();
    const artist = String(track.artist ?? "").trim();
    const title = String(track.title ?? "").trim();
    if (id && seenIds.has(id)) return false;

    const family = songFamilyKey({ artist, title });
    const baseTitle = baseTrackTitle(title);
    const isVariant = trackVariantPenalty(title) > 0;
    if (artist && baseTitle && seenFamilies.has(family)) return false;

    // If artist credits changed between remix releases, exact artist+title
    // identity is insufficient. Collapse by base title only when at least one
    // of the colliding records is explicitly an alternate version.
    if (baseTitle && baseTitleVariantState.has(baseTitle)) {
      const existingIsVariant = baseTitleVariantState.get(baseTitle) ?? false;
      if (existingIsVariant || isVariant) return false;
    }

    if (id) seenIds.add(id);
    if (artist && baseTitle) seenFamilies.add(family);
    if (baseTitle && !baseTitleVariantState.has(baseTitle)) {
      baseTitleVariantState.set(baseTitle, isVariant);
    }
    return true;
  });
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicOrder<T>(items: T[], seed: string, identity: (item: T) => string): T[] {
  return [...items].sort((left, right) => {
    const leftKey = `${seed}:${identity(left)}`;
    const rightKey = `${seed}:${identity(right)}`;
    return stableHash(leftKey) - stableHash(rightKey) || leftKey.localeCompare(rightKey);
  });
}

function artistKeywordOverlap(lhs: string, rhs: string): number {
  const left = new Set(
    normalizePhrase(lhs)
      .split(/[^\p{L}\p{N}]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length >= 3)
  );
  const right = new Set(
    normalizePhrase(rhs)
      .split(/[^\p{L}\p{N}]+/u)
      .map((value) => value.trim())
      .filter((value) => value.length >= 3)
  );

  let overlap = 0;
  for (const value of left) {
    if (right.has(value)) overlap++;
  }
  return overlap;
}

function fuzzyListMatch(text: string, terms: string[]): number {
  let matches = 0;
  for (const term of terms) {
    if (term && text.includes(term)) matches++;
  }
  return matches;
}

function fuzzyTagMatch(tags: string[], terms: string[]): number {
  let matches = 0;
  for (const term of terms) {
    if (!term) continue;
    if (tags.some((tag) => tag.includes(term) || term.includes(tag))) {
      matches++;
    }
  }
  return matches;
}

function matchesLanguageFilter(row: VibeTrackRow, language: VibeFilters["language"]): boolean {
  if (!language) return true;
  const combined = `${row.artist} ${row.title} ${row.album ?? ""}`;
  const hasCyrillic = VIBE_CYRILLIC_RE.test(combined);
  return language === "russian" ? hasCyrillic : !hasCyrillic;
}

function matchesMoodFilter(row: VibeTrackRow, moodTerms: string[], extraTags: string[] = []): boolean {
  if (moodTerms.length === 0) return true;
  const text = normalizePhrase(`${row.title} ${row.artist} ${row.album ?? ""} ${row.genre ?? ""} ${row.mood ?? ""}`);
  const tags = [
    ...splitTagField(row.genre).map(normalizePhrase),
    ...splitTagField(row.mood).map(normalizePhrase),
    ...extraTags.map(normalizePhrase),
  ];
  return moodTerms.some((term) => text.includes(term) || tags.some((tag) => tag.includes(term) || term.includes(tag)));
}

function scoreVibeCandidate(
  candidate: RankedVibeCandidate,
  context: {
    mode: StationMode;
    seedArtists: string[];
    seedArtistSet: Set<string>;
    seedAlbums: string[];
    seedGenres: string[];
    seedMoods: string[];
    seedKeywords: string[];
    similarArtists: string[];
    similarTitleKeywords: string[];
    moodTerms: string[];
    filters: Required<Pick<VibeFilters, "character">> & VibeFilters;
    userStats: Map<string, UserTrackStats>;
    userArtistStats: Map<string, UserArtistStats>;
    trackTags?: Map<string, string[]>;
    acceptedArtistKeys?: Set<string>;
    acceptedCfNeighbors?: Set<string>;
    session?: StationSessionContext;
  }
): number | null {
  const row = candidate.row;
  const personal = context.userStats.get(canonicalSongKey(row));
  const now = Date.now() / 1000;
  const lastDislike = personal?.lastDislikedAt ?? 0;
  const lastLike = personal?.lastLikedAt ?? 0;
  if (lastDislike > lastLike) {
    const age = Math.max(0, now - lastDislike);
    if (age < 30 * 86400) return null;
  }
  if (!matchesLanguageFilter(row, context.filters.language)) return null;
  const extraTags = context.trackTags?.get(row.id) ?? [];
  if (!matchesMoodFilter(row, context.moodTerms, extraTags)) return null;

  const artist = normalizePhrase(row.artist);
  const artistIdentity = normalizeArtistIdentity(row.artist);
  const artistPersonal = context.userArtistStats.get(artistIdentity);
  const album = normalizePhrase(row.album);
  const text = normalizePhrase(`${row.title} ${row.artist} ${row.album ?? ""}`);
  const tags = [
    ...splitTagField(row.genre).map(normalizePhrase),
    ...splitTagField(row.mood).map(normalizePhrase),
    ...extraTags.map(normalizePhrase),
  ];

  let score = candidate.baseScore * 4.4 + candidate.signalCount * 1.6;
  if (lastDislike > lastLike) {
    const ageDays = Math.max(0, (now - lastDislike) / 86400);
    score -= 25 * Math.exp(-ageDays / 14);
  }
  const sessionSkips = context.session?.skippedArtists.get(artistIdentity) ?? 0;
  if (sessionSkips >= 2) score -= 40;
  else if (sessionSkips === 1) score -= 12;
  if (context.session?.rapidSkip || (context.session?.skipStreak ?? 0) >= 3) {
    const familiar = Boolean(context.userStats.get(canonicalSongKey(row))?.positiveCount) || context.seedArtistSet.has(artist);
    score += familiar ? 10 : -10;
  }
  score += fuzzyListMatch(artist, context.seedArtists) * 1.8;
  score += fuzzyListMatch(album, context.seedAlbums) * 3.2;
  score += fuzzyListMatch(text, context.seedKeywords) * 2.2;
  score += fuzzyListMatch(text, context.similarTitleKeywords) * 3.1;
  score += fuzzyListMatch(artist, context.similarArtists) * 1.7;
  score += fuzzyTagMatch(tags, context.seedGenres) * 4;
  score += fuzzyTagMatch(tags, context.seedMoods) * 3.6;

  if (artistPersonal) {
    const dislikeBalance = Math.max(0, artistPersonal.dislikeCount - artistPersonal.likeCount);
    const artistDislikeAge = artistPersonal.lastDislikedAt
      ? Math.max(0, now - artistPersonal.lastDislikedAt)
      : Number.POSITIVE_INFINITY;
    if (artistPersonal.dislikeCount >= 2 && artistDislikeAge < 14 * 86400) score *= 0.5;
    else score -= Math.min(6, dislikeBalance * 2);
    const skipInteractions = artistPersonal.positiveCount + artistPersonal.earlySkipCount;
    if (artistPersonal.earlySkipCount >= 2 && skipInteractions > 0) {
      const earlySkipRate = artistPersonal.earlySkipCount / skipInteractions;
      score -= Math.min(18, artistPersonal.earlySkipCount * 1.8 + earlySkipRate * 8);
    } else if (artistPersonal.positiveCount >= 3) {
      score += Math.min(3, Math.log1p(artistPersonal.positiveCount));
    }
  }

  if (context.moodTerms.length > 0) {
    score += 10;
    score += fuzzyTagMatch(tags, context.moodTerms) * 2;
    score += fuzzyListMatch(text, context.moodTerms) * 1.5;
  }

  if (context.mode === "my_vibe" && context.session && context.session.acceptedSeeds.length > 0) {
    const acceptedArtist = context.acceptedArtistKeys?.has(artistIdentity) ?? false;
    const acceptedNeighbor = context.acceptedCfNeighbors?.has(row.id) ?? false;
    let sessionBonus = 0;
    if (acceptedArtist) sessionBonus += 8;
    if (acceptedNeighbor) sessionBonus += 5;
    if (extraTags.length > 0 && context.session.acceptedSeeds.some((seed) => {
      const seedTags = context.trackTags?.get(seed.id ?? "") ?? [];
      return seedTags.some((tag) => extraTags.includes(tag));
    })) sessionBonus += 3;
    score += Math.min(12, sessionBonus);
  }

  const relatedSeedArtistOverlap = Math.max(
    context.seedArtistSet.has(artist) ? 1 : 0,
    ...context.seedArtists.map((seedArtist) => artistKeywordOverlap(artist, seedArtist))
  );

  if (relatedSeedArtistOverlap > 0) {
    if (context.mode === "auto_mix") {
      score -= 4.5 * relatedSeedArtistOverlap;
    } else {
      switch (context.filters.character) {
        case "favorite":
          score += 0.75;
          break;
        case "unfamiliar":
          score -= 7 * relatedSeedArtistOverlap;
          break;
        case "popular":
          score -= 2.5 * relatedSeedArtistOverlap;
          break;
      }
    }
  }

  const playCount = personal?.positiveCount ?? 0;
  const lastPlayedAt = personal?.lastPlayedAt ?? 0;
  const hoursSinceLastPlay = lastPlayedAt > 0 ? (Date.now() / 1000 - lastPlayedAt) / 3600 : Number.POSITIVE_INFINITY;
  const hoursSinceLastSkip = personal?.lastSkippedAt
    ? (Date.now() / 1000 - personal.lastSkippedAt) / 3600
    : Number.POSITIVE_INFINITY;

  if (personal?.earlySkipCount) {
    if (hoursSinceLastSkip < 24) score -= 18;
    else if (hoursSinceLastSkip < 24 * 7) score -= 7;
  }

  if (context.mode === "auto_mix") {
    score += Math.min(playCount, 12) * 0.4;
    if (hoursSinceLastPlay === Number.POSITIVE_INFINITY) score += 1.8;
    if (hoursSinceLastPlay < 24 * 2) score -= 2.5;
    else if (hoursSinceLastPlay > 24 * 30) score += 1;
  } else {
    switch (context.filters.character) {
      case "favorite":
        score += Math.min(playCount, 18) * 1.4;
        if (hoursSinceLastPlay < 24 * 7) score += 4;
        else if (hoursSinceLastPlay < 24 * 30) score += 2;
        break;
      case "unfamiliar":
        score += Math.max(0, 16 - Math.min(playCount, 16));
        if (playCount === 0) score += 6;
        if (hoursSinceLastPlay === Number.POSITIVE_INFINITY) score += 3;
        if (hoursSinceLastPlay < 24 * 14) score -= 7;
        else if (hoursSinceLastPlay < 24 * 45) score -= 3;
        break;
      case "popular":
        score += Math.log1p(row.play_count) * 4;
        if (hoursSinceLastPlay < 24 * 21) score += 1.5;
        break;
    }
  }

  // Global popularity is a weak prior only; personal behaviour dominates.
  score += Math.log1p(row.play_count) * 0.25;
  // Prefer the most reliable playable copy when the same recording exists in
  // several catalogues. Canonical-song dedupe will keep the highest one.
  if (row.source === "local") score += 3;
  else if (row.source === "yandex") score += 2.5;
  else if (row.source === "soundcloud") score += 1.25;
  else if (row.source === "youtube") score += 0.25;
  score -= trackVariantPenalty(row.title);
  if (row.genre) score += 0.35;
  if (row.mood) score += 0.35;
  return score;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function querySimilarTrackMatches(db: ReturnType<typeof getDb>, signal: SimilarTrackSignal): VibeTrackRow[] {
  const titleQuery = signal.title.trim();
  const artistQuery = signal.artist.trim();
  if (!titleQuery || !artistQuery) return [];

  const rows = db.prepare(`
    SELECT * FROM tracks
    WHERE lower(artist) LIKE lower($artist)
       OR lower(title) LIKE lower($title)
       OR lower(COALESCE(album, '')) LIKE lower($title)
    ORDER BY play_count DESC, updated_at DESC
    LIMIT 24
  `).all({
    $artist: `%${artistQuery}%`,
    $title: `%${titleQuery}%`,
  }) as Record<string, unknown>[];

  const wantedArtist = normalizeArtistKey(artistQuery);
  const wantedTitle = normalizeTitleKey(titleQuery);
  const wantedTitleKeywords = extractVibeKeywords([titleQuery], 6).map(normalizePhrase);

  return rows
    .map(normalizeTrackRow)
    .filter((row) => {
      if (!isDiscoverableRow(row)) return false;
      const rowArtist = normalizeArtistKey(row.artist);
      const rowTitle = normalizeTitleKey(row.title);
      const artistMatch = rowArtist.includes(wantedArtist) || wantedArtist.includes(rowArtist);
      const exactTitleMatch = rowTitle.includes(wantedTitle) || wantedTitle.includes(rowTitle);
      const keywordHits = fuzzyListMatch(rowTitle, wantedTitleKeywords);
      return (artistMatch && (exactTitleMatch || keywordHits > 0)) || exactTitleMatch || keywordHits >= 2;
    });
}

export function selectDiverseTracks(
  rankedRows: VibeTrackRow[],
  limit: number,
  context: {
    mode: StationMode;
    seedArtists: string[];
    filters: Required<Pick<VibeFilters, "character">> & VibeFilters;
    queueTail?: VibeSeed[];
  }
): VibeTrackRow[] {
  const familySafeRows = collapseTrackVariants(rankedRows);
  const selected: VibeTrackRow[] = [];
  const selectedIDs = new Set<string>();
  const selectedTitles = new Set<string>((context.queueTail ?? []).map((row) => songFamilyKey({ artist: row.artist ?? "", title: row.title ?? "" })));
  const tailArtists = (context.queueTail ?? []).map((row) => normalizeArtistKey(row.artist)).filter(Boolean).slice(-3);
  const tailAlbums = new Set((context.queueTail ?? []).map((row) => row.album ? `${normalizeArtistKey(row.artist)}::${normalizeTitleKey(row.album)}` : "").filter(Boolean));
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const seedArtistSet = new Set(context.seedArtists.map(normalizeArtistKey));

  const seedArtistMax =
    context.mode === "auto_mix"
      ? 1
      : context.filters.character === "favorite"
        ? 2
        : 1;

  const passes = [
    { seedArtistMax, otherArtistMax: 2, albumMax: 2 },
    { seedArtistMax: seedArtistMax + 1, otherArtistMax: 3, albumMax: 2 },
    { seedArtistMax: seedArtistMax + 2, otherArtistMax: 4, albumMax: 3 },
  ];

  for (const pass of passes) {
    for (const row of familySafeRows) {
      if (selected.length >= limit) break;
      if (selectedIDs.has(row.id)) continue;
      if (!isDiscoverableRow(row)) continue;

      const artistKey = normalizeArtistKey(row.artist);
      const titleKey = canonicalSongKey(row);
      const albumKey = row.album ? `${artistKey}::${normalizeTitleKey(row.album)}` : "";
      const seedRelatedArtist = seedArtistSet.has(artistKey) || context.seedArtists.some((seedArtist) => artistKeywordOverlap(artistKey, seedArtist) > 0);
      const artistLimit = seedRelatedArtist ? pass.seedArtistMax : pass.otherArtistMax;

      if ((artistCounts.get(artistKey) ?? 0) >= artistLimit) continue;
      if (selectedTitles.has(titleKey)) continue;
      const recentArtists = [...tailArtists, ...selected.slice(-3).map((track) => normalizeArtistKey(track.artist))].slice(-3);
      if (recentArtists.includes(artistKey) && pass === passes[0]) continue;
      if (albumKey && tailAlbums.has(albumKey) && pass === passes[0]) continue;
      if (albumKey && (albumCounts.get(albumKey) ?? 0) >= pass.albumMax) continue;

      selected.push(row);
      selectedIDs.add(row.id);
      selectedTitles.add(titleKey);
      artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
      if (albumKey) {
        albumCounts.set(albumKey, (albumCounts.get(albumKey) ?? 0) + 1);
      }
    }
    if (selected.length >= limit) break;
  }

  for (const row of familySafeRows) {
    if (selected.length >= limit) break;
    const songKey = canonicalSongKey(row);
    if (selectedIDs.has(row.id) || selectedTitles.has(songKey) || !isDiscoverableRow(row)) continue;
    selected.push(row);
    selectedIDs.add(row.id);
    selectedTitles.add(songKey);
  }

  return sequenceForPlayback(selected.slice(0, limit), familySafeRows);
}

function sequenceForPlayback(selected: VibeTrackRow[], rankedRows: VibeTrackRow[]): VibeTrackRow[] {
  if (selected.length < 3) return selected;
  const rank = new Map(rankedRows.map((row, index) => [row.id, index]));
  const remaining = selected.slice(1);
  const result = [selected[0]];

  const tags = (row: VibeTrackRow) => new Set([
    ...splitTagField(row.genre).map(normalizePhrase),
    ...splitTagField(row.mood).map(normalizePhrase),
  ]);

  while (remaining.length > 0) {
    const previous = result[result.length - 1];
    const previousTags = tags(previous);
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      const candidateTags = tags(candidate);
      let sharedTags = 0;
      for (const tag of candidateTags) if (previousTags.has(tag)) sharedTags++;

      let score = 12 - (rank.get(candidate.id) ?? selected.length) * 0.22;
      score += Math.min(sharedTags, 2) * 1.8;
      if (normalizeArtistKey(candidate.artist) === normalizeArtistKey(previous.artist)) score -= 7;
      if (candidate.album && previous.album && normalizeTitleKey(candidate.album) === normalizeTitleKey(previous.album)) score -= 3;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    result.push(remaining.splice(bestIndex, 1)[0]);
  }
  return result;
}

export function profileSeeds(profile: ReturnType<typeof buildWeightedProfile>, limit = 6): VibeSeed[] {
  const contextualArtists = new Set(getTimeContextArtists(profile).map(normalizeArtistKey));
  const contextual = profile.topTracks.filter((track) => contextualArtists.has(normalizeArtistKey(track.artist)));
  const ordered = uniqueStrings(
    [
      ...profile.topTracks.slice(0, Math.max(2, Math.ceil(limit * 0.6))),
      ...contextual,
      ...profile.topTracks,
    ].map((track) => JSON.stringify(track)),
    limit
  ).map((track) => JSON.parse(track) as (typeof profile.topTracks)[number]);

  return ordered.map((track) => ({
    id: track.id,
    artist: track.artist,
    title: track.title,
  }));
}

interface SessionTransitionEvent {
  id: number;
  session_id: string;
  track_id: string;
  action: string;
  played_at: number;
  played_ratio: number | null;
  artist: string;
  title: string;
}

function acceptedSessionEvent(event: SessionTransitionEvent): boolean {
  if (event.action === "complete") return true;
  if (event.action === "play" && event.played_ratio == null) return true;
  return event.played_ratio != null && event.played_ratio >= 0.5;
}

function sessionTransitionSignals(
  userId: string | null,
  seedIDs: string[],
  seedArtists: string[]
): Map<string, number> {
  if (seedIDs.length === 0 && seedArtists.length === 0) return new Map();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 120 * 86400;
  const events = db.prepare(`
    SELECT lh.id, lh.session_id, lh.track_id, lh.action, lh.played_at,
           lh.played_ratio, t.artist, t.title
    FROM listening_history lh
    JOIN tracks t ON t.id = lh.track_id
    WHERE lh.session_id IS NOT NULL
      AND lh.played_at >= $cutoff
      AND lh.action IN ('play', 'complete', 'skip')
      AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))
    ORDER BY lh.session_id, lh.played_at, lh.id
    LIMIT 5000
  `).all({ $cutoff: cutoff, $userId: userId }) as SessionTransitionEvent[];

  const seedIdSet = new Set(seedIDs);
  const seedArtistKeys = seedArtists.map(normalizeArtistKey);
  const scores = new Map<string, number>();
  let previous: SessionTransitionEvent | null = null;

  for (const event of events) {
    const sameSession = previous?.session_id === event.session_id;
    const closeInTime = previous != null && event.played_at - previous.played_at <= 45 * 60;
    if (sameSession && closeInTime && previous && acceptedSessionEvent(previous) && acceptedSessionEvent(event)) {
      const exactSeed = seedIdSet.has(previous.track_id);
      const previousArtist = normalizeArtistKey(previous.artist);
      const artistSeed = seedArtistKeys.some((seed) =>
        seed === previousArtist || artistKeywordOverlap(seed, previousArtist) > 0
      );
      if ((exactSeed || artistSeed) && !seedIdSet.has(event.track_id)
        && canonicalSongKey(previous) !== canonicalSongKey(event)) {
        const ageDays = Math.max(0, (Date.now() / 1000 - event.played_at) / 86400);
        const recency = Math.exp(-Math.LN2 * ageDays / 30);
        const ratio = event.action === "complete" ? 1 : Math.min(event.played_ratio ?? 0.65, 1);
        const strength = (exactSeed ? 3.2 : 1.25) * (0.7 + ratio * 0.6) * recency;
        scores.set(event.track_id, Math.min(12, (scores.get(event.track_id) ?? 0) + strength));
      }
    }
    previous = event;
  }

  return scores;
}

function balanceFamiliarity(
  rows: VibeTrackRow[],
  userStats: Map<string, UserTrackStats>,
  candidates: Map<string, RankedVibeCandidate>,
  limit: number,
  mode: StationMode,
  character: NonNullable<VibeFilters["character"]>
): VibeTrackRow[] {
  const configuredRatio = (key: string): number | null => {
    const raw = process.env[key] ?? (() => {
      try {
        return (getDb().prepare("SELECT value FROM reco_settings WHERE key = $key").get({ $key: key }) as { value: string } | null)?.value;
      } catch {
        return undefined;
      }
    })();
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(0.9, value)) : null;
  };
  const modeKey = mode === "auto_mix" ? "RECO_DISCOVERY_RATIO_AUTO_MIX" : `RECO_DISCOVERY_RATIO_${character.toUpperCase()}`;
  const discoveryRatio = configuredRatio(modeKey) ?? configuredRatio("RECO_DISCOVERY_RATIO") ?? (mode === "auto_mix"
    ? 0.45
    : character === "unfamiliar"
      ? 0.7
      : character === "popular"
        ? 0.2
        : 0.3);
  const candidateWindow = rows.slice(0, Math.max(30, limit * 3));
  const familiar = candidateWindow.filter((row) => (userStats.get(canonicalSongKey(row))?.positiveCount ?? 0) > 0);
  const discovery = candidateWindow.filter((row) => {
    const stats = userStats.get(canonicalSongKey(row));
    if ((stats?.positiveCount ?? 0) > 0) return false;
    const provenance = candidates.get(row.id);
    // Do not promote arbitrary global-cache filler into the exploration lane.
    // Every discovery item needs a real relation signal from Rotor,
    // artist/album/genre, Last.fm or learned session transitions.
    if ((provenance?.baseScore ?? 0) <= 0.5) return false;
    const daysSinceSkip = stats?.lastSkippedAt
      ? (Date.now() / 1000 - stats.lastSkippedAt) / 86400
      : Number.POSITIVE_INFINITY;
    return !(stats?.earlySkipCount && daysSinceSkip < 30);
  });
  if (familiar.length === 0 || discovery.length === 0) return rows;

  const result: VibeTrackRow[] = [];
  let familiarIndex = 0;
  let discoveryIndex = 0;
  let discoveryCount = 0;
  while (result.length < candidateWindow.length) {
    const targetDiscovery = Math.round((result.length + 1) * discoveryRatio);
    const useDiscovery = discoveryCount < targetDiscovery && discoveryIndex < discovery.length;
    const next = useDiscovery
      ? discovery[discoveryIndex++]
      : familiar[familiarIndex++] ?? discovery[discoveryIndex++];
    if (!next) break;
    if (useDiscovery || familiarIndex > familiar.length) discoveryCount++;
    result.push(next);
  }

  const selected = new Set(result.map((row) => row.id));
  return [...result, ...rows.filter((row) => !selected.has(row.id))];
}

export async function getSimilarTracksFromLastfm(seeds: VibeSeed[]): Promise<SimilarTrackSignal[]> {
  if (!getLastfmKey()) return [];

  const hydratedSeeds = seeds
    .filter((seed): seed is Required<Pick<VibeSeed, "artist" | "title">> => Boolean(seed.artist?.trim() && seed.title?.trim()))
    .slice(0, 4);

  const settled = await Promise.allSettled(hydratedSeeds.map(async (seed) => {
    const cacheKey = `track-similar:${normalizeArtistKey(seed.artist)}:${normalizeTitleKey(seed.title)}`;
    const cached = getCached<SimilarTrackSignal[]>(cacheKey);
    if (cached) return cached;

    const data = await lastfmGet({
      method: "track.getSimilar",
      artist: seed.artist,
      track: seed.title,
      limit: "18",
      autocorrect: "1",
    }) as {
      similartracks?: {
        track?: Array<{
          name?: string;
          match?: number | string;
          artist?: { name?: string };
        }>
      }
    };

    const result = uniqueStrings(
      (data.similartracks?.track ?? [])
        .map((track) => {
          const artist = track.artist?.name?.trim();
          const title = track.name?.trim();
          if (!artist || !title) return null;
          const rawMatch = Number(track.match ?? 0);
          return JSON.stringify({
            artist,
            title,
            match: Number.isFinite(rawMatch) ? rawMatch : 0,
          });
        })
        .filter((value): value is string => Boolean(value)),
      18
    ).map((value) => JSON.parse(value) as SimilarTrackSignal);

    setCached(cacheKey, result, 12 * 3600_000);
    return result;
  }));

  const byKey = new Map<string, SimilarTrackSignal>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) {
      const key = `${normalizeArtistKey(item.artist)}::${normalizeTitleKey(item.title)}`;
      const existing = byKey.get(key);
      if (!existing || item.match > existing.match) {
        byKey.set(key, item);
      }
    }
  }

  return [...byKey.values()]
    .sort((lhs, rhs) => rhs.match - lhs.match)
    .slice(0, 24);
}

function loadTrackTags(db: ReturnType<typeof getDb>, trackIDs: string[]): Map<string, string[]> {
  const uniqueIDs = [...new Set(trackIDs.filter(Boolean))];
  if (uniqueIDs.length === 0) return new Map();
  const placeholders = uniqueIDs.map((_, index) => `$tagTrack${index}`).join(", ");
  const params = Object.fromEntries(uniqueIDs.map((id, index) => [`$tagTrack${index}`, id]));
  const rows = db.prepare(`
    SELECT track_id, tag, weight FROM track_tags
    WHERE track_id IN (${placeholders}) ORDER BY weight DESC
  `).all(params) as Array<{ track_id: string; tag: string; weight: number }>;
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const tag = canonicalizeTag(row.tag) ?? normalizePhrase(row.tag);
    if (!tag) continue;
    const values = result.get(row.track_id) ?? [];
    if (!values.includes(tag) && values.length < 20) values.push(tag);
    result.set(row.track_id, values);
  }
  return result;
}

function loadCooldownSongKeys(
  db: ReturnType<typeof getDb>,
  userId: string | null,
  surface: string,
  hours: number
): Set<string> {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, hours) * 3600;
  const result = new Set<string>();
  const history = db.prepare(`
    SELECT t.artist, t.title
    FROM listening_history lh JOIN tracks t ON t.id = lh.track_id
    WHERE lh.played_at >= $cutoff AND lh.surface = $surface
      AND lh.action IN ('play', 'complete', 'skip')
      AND (lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL))
    ORDER BY lh.played_at DESC LIMIT 1000
  `).all({ $cutoff: cutoff, $surface: surface, $userId: userId }) as Array<{ artist: string; title: string }>;
  const impressions = db.prepare(`
    SELECT t.artist, t.title
    FROM recommendation_impressions ri JOIN tracks t ON t.id = ri.track_id
    WHERE ri.created_at >= $cutoff AND ri.surface = $surface
      AND (ri.user_id = $userId OR (ri.user_id IS NULL AND $userId IS NULL))
    ORDER BY ri.created_at DESC LIMIT 1000
  `).all({ $cutoff: cutoff, $surface: surface, $userId: userId }) as Array<{ artist: string; title: string }>;
  for (const row of [...history, ...impressions]) result.add(canonicalSongKey(row));
  return result;
}

async function warmExternalCandidateCatalog(
  seedArtists: string[],
  similarSignals: SimilarTrackSignal[],
  enabledSources: Set<string>,
  userId: string | null
): Promise<void> {
  const sourceScope = [...enabledSources].sort().join(",");
  const warmKey = `catalog-warm:${safeScope(`${userId ?? "anonymous"}:${sourceScope}`)}:${seedArtists.slice(0, 2).join("|")}:${similarSignals
    .slice(0, 8)
    .map((signal) => `${signal.artist}:${signal.title}`)
    .join("|")}`.toLowerCase();
  if (getCached<boolean>(warmKey)) return;

  const db = getDb();
  const yandexProvider = getYandexProvider();
  const providers = [
    enabledSources.has("yandex") && yandexProvider.isAuthenticated() ? yandexProvider : null,
    enabledSources.has("youtube") ? getYouTubeProvider() : null,
    enabledSources.has("soundcloud") ? getSoundCloudProvider() : null,
  ].filter((provider): provider is Exclude<typeof provider, null> => provider != null);

  await getOrCreateInFlight(warmKey, async () => {
    // Populate a small slice of the real provider catalogue instead of limiting
    // recommendations to tracks that happened to be cached by previous searches.
    const artistTasks = seedArtists.slice(0, 2).flatMap((artist) => providers.map(async (provider) => {
      const count = (db.prepare(
        "SELECT COUNT(*) AS n FROM tracks WHERE lower(artist) LIKE lower($artist)"
      ).get({ $artist: `%${artist}%` }) as { n: number }).n;
      if (count < 6) await provider.getArtistTracks(artist);
    }));

    const signalTasks = similarSignals.slice(0, 8).flatMap((signal) => providers.map(async (provider) => {
      if (querySimilarTrackMatches(db, signal).some((row) => enabledSources.has(row.source))) return;
      await provider.search(`${signal.artist} ${signal.title}`, 5, 0);
    }));

    const stationTasks: Promise<unknown>[] = [];
    const waveCacheKey = yandexWaveCacheKey(userId);
    if (enabledSources.has("yandex") && yandexProvider.isAuthenticated()
      && !getCached<Array<Record<string, unknown>>>(waveCacheKey)) {
      stationTasks.push(
        yandexProvider.getStationTracks("user:onyourwave", 60).then((tracks) => {
          setCached(waveCacheKey, tracks.map((track) => ({ ...track })), 15 * 60_000);
        })
      );
    }

    await Promise.allSettled([...artistTasks, ...signalTasks, ...stationTasks]);
    setCached(warmKey, true, 15 * 60_000);
  });
}

export async function buildStationTracks(options: {
  mode: StationMode;
  seeds: VibeSeed[];
  excludeIds?: string[];
  limit?: number;
  filters?: VibeFilters;
  userId?: string | null;
  deterministicSeed?: string;
  session?: StationSessionContext;
}): Promise<{
  tracks: VibeTrackRow[];
  filters: Required<Pick<VibeFilters, "character">> & VibeFilters;
  seedCount: number;
}> {
  const db = getDb();
  const requestedLimit = Number(options.limit ?? 24);
  const limit = Number.isFinite(requestedLimit) ? Math.max(8, Math.min(Math.floor(requestedLimit), 60)) : 24;
  const session = options.session;
  const seeds = [...options.seeds, ...(session?.acceptedSeeds ?? [])].slice(0, 20);
  const userId = options.userId ?? null;
  const exclude = new Set<string>((options.excludeIds ?? []).slice(0, 500));
  const excludedSongKeys = new Set<string>();
  if (exclude.size > 0) {
    const ids = [...exclude];
    const placeholders = ids.map((_, index) => `$excluded${index}`).join(", ");
    const params = Object.fromEntries(ids.map((id, index) => [`$excluded${index}`, id]));
    const rows = db.prepare(`SELECT artist, title FROM tracks WHERE id IN (${placeholders})`)
      .all(params) as Array<Pick<VibeTrackRow, "artist" | "title">>;
    rows.forEach((row) => excludedSongKeys.add(canonicalSongKey(row)));
  }
  const applyCooldown = options.mode === "auto_mix" || Boolean(session);
  const cooldownSongKeys = applyCooldown
    ? loadCooldownSongKeys(
      db,
      userId,
      options.mode,
      Number(process.env.RECO_REPEAT_COOLDOWN_HOURS ?? 12)
    )
    : new Set<string>();
  if (session?.reactionRefresh) {
    for (const item of [...session.queueTail, ...session.recentOutcomes]) {
      if (item.artist && item.title) cooldownSongKeys.add(canonicalSongKey({ artist: item.artist, title: item.title }));
    }
  }
  const seedIDs = uniqueStrings(seeds.map((seed) => seed.id), 20);
  const filters: Required<Pick<VibeFilters, "character">> & VibeFilters = {
    character: options.filters?.character ?? "favorite",
    language: options.filters?.language,
    mood: options.filters?.mood,
  };

  const seedArtists = uniqueStrings(seeds.map((seed) => seed.artist), 10).map(normalizePhrase);
  const seedAlbums = uniqueStrings(seeds.map((seed) => seed.album), 8).map(normalizePhrase);
  const seedKeywords = extractVibeKeywords(
    seeds.flatMap((seed) => [seed.title, seed.album, seed.artist]),
    12
  );
  const requestedMoodTerms = options.mode === "my_vibe" ? expandMoodTerms(filters.mood) : [];

  let seedGenres: string[] = [];
  let seedMoods: string[] = [];
  let seedTags: string[] = [];

  if (seedIDs.length > 0) {
    const placeholders = seedIDs.map((_, index) => `$seed${index}`).join(", ");
    const params = Object.fromEntries(seedIDs.map((id, index) => [`$seed${index}`, id]));
    const rows = db.prepare(`SELECT genre, mood FROM tracks WHERE id IN (${placeholders})`).all(params) as VibeMetadataRow[];
    seedGenres = uniqueStrings(rows.flatMap((row) => splitTagField(row.genre)), 8).map(normalizePhrase);
    seedMoods = uniqueStrings(rows.flatMap((row) => splitTagField(row.mood)), 8).map(normalizePhrase);
    seedTags = [...loadTrackTags(db, seedIDs).values()].flat();
  }

  if (seedArtists.length === 0 && seedGenres.length === 0 && seedMoods.length === 0) {
    const profile = buildWeightedProfile(userId);
    seedArtists.push(...uniqueStrings(profile.topArtists.map((artist) => artist.artist), 6).map(normalizePhrase));
    seedGenres.push(...uniqueStrings(profile.topGenres.map((genre) => genre.genre), 4).map(normalizePhrase));
    seedMoods.push(...uniqueStrings(profile.topMoods.map((mood) => mood.mood), 4).map(normalizePhrase));
  }

  if (requestedMoodTerms.length > 0) {
    seedMoods = uniqueStrings([...seedMoods, ...requestedMoodTerms], 10).map(normalizePhrase);
  }

  const seedArtistSet = new Set(seedArtists);

  const allowsExternalDiscovery = !session || [...session.enabledSources].some((source) => source !== "local");
  const similarTrackSignals = allowsExternalDiscovery ? await getSimilarTracksFromLastfm(seeds) : [];
  if (allowsExternalDiscovery) {
    const warmPromise = warmExternalCandidateCatalog(
      seedArtists,
      similarTrackSignals,
      session?.enabledSources ?? new Set(["yandex", "youtube", "soundcloud"]),
      userId
    );
    if (session?.reactionRefresh) void warmPromise.catch(() => undefined);
    else await warmPromise;
  }
  const similarArtists = uniqueStrings(similarTrackSignals.map((track) => track.artist), 12).map(normalizePhrase);
  const similarTitleKeywords = extractVibeKeywords(similarTrackSignals.map((track) => track.title), 16);

  const candidates = new Map<string, RankedVibeCandidate>();
  const cfSimilarities = new Map<string, number>();
  const addCandidates = (rows: Array<Record<string, unknown>>, score: number, ignoreCooldown = false) => {
    for (const row of rows) {
      const normalizedRow = normalizeTrackRow(row);
      const id = normalizedRow.id;
      if (!id || exclude.has(id) || excludedSongKeys.has(canonicalSongKey(normalizedRow))) continue;
      if (!ignoreCooldown && cooldownSongKeys.has(canonicalSongKey(normalizedRow))) continue;
      if (session && !session.enabledSources.has(normalizedRow.source.toLowerCase())) continue;
      const existing = candidates.get(id);
      if (existing) {
        existing.baseScore += score;
        existing.signalCount += 1;
      } else {
        candidates.set(id, { row: normalizedRow, baseScore: score, signalCount: 1 });
      }
    }
  };

  const transitionSignals = sessionTransitionSignals(userId, seedIDs, seedArtists);
  if (transitionSignals.size > 0) {
    const transitionIDs = [...transitionSignals.keys()];
    const placeholders = transitionIDs.map((_, index) => `$transition${index}`).join(", ");
    const params = Object.fromEntries(transitionIDs.map((id, index) => [`$transition${index}`, id]));
    const rows = db.prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`).all(params) as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row.id ?? "");
      addCandidates([row], 2.5 + (transitionSignals.get(id) ?? 0));
    }
  }

  // Persisted item-item similarities complement the request-local transition
  // signal above. Read all seed families in one query and normalize scores per
  // response so a single very popular item cannot swamp the station.
  if (seedIDs.length > 0) {
    const placeholders = seedIDs.map((_, index) => `$similarSeed${index}`).join(", ");
    const params = Object.fromEntries(seedIDs.map((id, index) => [`$similarSeed${index}`, id]));
    const similarRows = db.prepare(`
      SELECT si.other_id, MAX(si.score) AS score
      FROM similar_items si
      WHERE si.track_id IN (${placeholders})
      GROUP BY si.other_id ORDER BY score DESC LIMIT 200
    `).all(params) as Array<{ other_id: string; score: number }>;
    const maxScore = Math.max(...similarRows.map((row) => Number(row.score) || 0), 0.001);
    const otherIDs = similarRows.map((row) => row.other_id);
    if (otherIDs.length > 0) {
      const otherPlaceholders = otherIDs.map((_, index) => `$similarOther${index}`).join(", ");
      const otherParams = Object.fromEntries(otherIDs.map((id, index) => [`$similarOther${index}`, id]));
      const rows = db.prepare(`SELECT * FROM tracks WHERE id IN (${otherPlaceholders})`).all(otherParams) as Record<string, unknown>[];
      const byID = new Map(rows.map((row) => [String(row.id ?? ""), row]));
      for (const similar of similarRows) {
      const row = byID.get(similar.other_id);
        if (row) {
          cfSimilarities.set(similar.other_id, Number(similar.score) || 0);
          addCandidates([row], 6 * (Number(similar.score) || 0) / maxScore);
        }
      }
    }
  }

  const waveCandidates = (session?.enabledSources.has("yandex") ?? true)
    ? getCached<Array<Record<string, unknown>>>(yandexWaveCacheKey(userId)) ?? []
    : [];
  if (waveCandidates.length > 0) {
    const waveIDs = waveCandidates.map((track) => String(track.id ?? "")).filter(Boolean);
    if (waveIDs.length > 0) {
      const placeholders = waveIDs.map((_, index) => `$wave${index}`).join(", ");
      const params = Object.fromEntries(waveIDs.map((id, index) => [`$wave${index}`, id]));
      const rows = db.prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`).all(params) as Record<string, unknown>[];
      addCandidates(rows, 2.8);
    }
  }

  for (const signal of similarTrackSignals.slice(0, 18)) {
    const matchedRows = querySimilarTrackMatches(db, signal);
    if (matchedRows.length > 0) {
      addCandidates(matchedRows, 8 + Math.min(signal.match, 1) * 6);
    }
  }

  for (const artist of seedArtists.slice(0, 6)) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      WHERE lower(artist) LIKE lower($artist)
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 12
    `).all({ $artist: `%${artist}%` }) as Record<string, unknown>[];
    addCandidates(rows, options.mode === "my_vibe" ? 3.2 : 1.2);
  }

  for (const artist of similarArtists.slice(0, 6)) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      WHERE lower(artist) LIKE lower($artist)
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 10
    `).all({ $artist: `%${artist}%` }) as Record<string, unknown>[];
    addCandidates(rows, 2.4);
  }

  // Persistent artist graph: direct neighbours are strong discoveries, depth
  // two is deliberately decayed. Last.fm track similarities remain another
  // independent signal above.
  for (const artist of seedArtists.slice(0, 6)) {
    const related = relatedArtistKeys(artist, 20);
    for (const neighbour of related.slice(0, 20)) {
      const rows = db.prepare(`
        SELECT * FROM tracks
        WHERE lower(artist) LIKE lower($artist)
        ORDER BY play_count DESC, updated_at DESC LIMIT 10
      `).all({ $artist: `%${neighbour.key.split(" ").join("%")}%` }) as Record<string, unknown>[];
      addCandidates(rows, 5.5 * neighbour.score * (neighbour.depth === 2 ? 0.5 : 1));
    }
  }

  for (const album of seedAlbums.slice(0, 4)) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      WHERE album IS NOT NULL AND lower(album) LIKE lower($album)
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 12
    `).all({ $album: `%${album}%` }) as Record<string, unknown>[];
    addCandidates(rows, 4);
  }

  for (const mood of uniqueStrings([...seedMoods, ...requestedMoodTerms], 6)) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      WHERE lower(COALESCE(mood, '')) LIKE lower($mood)
         OR lower(COALESCE(genre, '')) LIKE lower($mood)
         OR lower(title) LIKE lower($mood)
         OR lower(artist) LIKE lower($mood)
         OR lower(COALESCE(album, '')) LIKE lower($mood)
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 14
    `).all({ $mood: `%${mood}%` }) as Record<string, unknown>[];
    addCandidates(rows, 4.8);
  }

  for (const genre of seedGenres.slice(0, 5)) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      WHERE genre IS NOT NULL AND lower(genre) LIKE lower($genre)
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 14
    `).all({ $genre: `%${genre}%` }) as Record<string, unknown>[];
    addCandidates(rows, 4.2);
  }

  const canonicalSeedTags = [...new Set([
    ...seedTags,
    ...seedGenres.map((tag) => canonicalizeTag(tag)).filter((tag): tag is string => Boolean(tag)),
    ...seedMoods.map((tag) => canonicalizeTag(tag)).filter((tag): tag is string => Boolean(tag)),
  ])].slice(0, 12);
  if (canonicalSeedTags.length > 0) {
    const tagPlaceholders = canonicalSeedTags.map((_, index) => `$seedTag${index}`).join(", ");
    const tagParams = Object.fromEntries(canonicalSeedTags.map((tag, index) => [`$seedTag${index}`, tag]));
    const rows = db.prepare(`
      SELECT DISTINCT t.* FROM tracks t
      JOIN track_tags tt ON tt.track_id = t.id
      WHERE tt.tag IN (${tagPlaceholders})
      ORDER BY t.play_count DESC, t.updated_at DESC LIMIT 100
    `).all(tagParams) as Record<string, unknown>[];
    addCandidates(rows, 4.5);
  }

  for (const keyword of [...seedKeywords, ...similarTitleKeywords].slice(0, 8)) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      WHERE lower(title) LIKE lower($keyword)
         OR lower(COALESCE(album, '')) LIKE lower($keyword)
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 10
    `).all({ $keyword: `%${keyword}%` }) as Record<string, unknown>[];
    addCandidates(rows, 2.2);
  }

  if (candidates.size < limit * 2) {
    const profile = buildWeightedProfile(userId);
    addCandidates(buildDailyMix(profile, [], userId), 1);
  }

  if (candidates.size < limit * 3) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 140
    `).all() as Record<string, unknown>[];
    addCandidates(rows, 0, true);
  }

  if (process.env.AUDIO_EMBEDDINGS_ENABLED === "1" && seedIDs.length > 0 && candidates.size > 0) {
    const seedPlaceholders = seedIDs.map((_, index) => `$audioSeed${index}`).join(", ");
    const seedParams = Object.fromEntries(seedIDs.map((id, index) => [`$audioSeed${index}`, id]));
    const seedRows = db.prepare(`
      SELECT vector FROM audio_embeddings WHERE track_id IN (${seedPlaceholders})
    `).all(seedParams) as Array<{ vector: unknown }>;
    const seedVectors = seedRows.map((row) => decodeEmbedding(row.vector)).filter((vector) => vector.length > 0);
    if (seedVectors.length > 0) {
      const candidateIDs = [...candidates.keys()];
      const placeholders = candidateIDs.map((_, index) => `$audioCandidate${index}`).join(", ");
      const params = Object.fromEntries(candidateIDs.map((id, index) => [`$audioCandidate${index}`, id]));
      const candidateRows = db.prepare(`
        SELECT track_id, vector FROM audio_embeddings WHERE track_id IN (${placeholders})
      `).all(params) as Array<{ track_id: string; vector: unknown }>;
      for (const row of candidateRows) {
        const vector = decodeEmbedding(row.vector);
        const similarity = Math.max(...seedVectors.map((seed) => cosineSimilarity(seed, vector)), 0);
        if (similarity <= 0) continue;
        const candidate = candidates.get(row.track_id);
        if (candidate) {
          candidate.baseScore += 4 * similarity;
          candidate.signalCount += 1;
        }
      }
    }
  }

  const userStatRows = db.prepare(`
    SELECT lh.track_id, t.artist, t.title,
           SUM(CASE
             WHEN (action = 'play' AND played_ratio IS NULL)
               OR (action IN ('play', 'complete', 'skip') AND played_ratio >= 0.5)
             THEN 1 ELSE 0 END) AS positive_count,
           SUM(CASE
             WHEN action = 'skip' AND COALESCE(played_ratio, 0) < 0.25
             THEN 1 ELSE 0 END) AS early_skip_count,
           SUM(CASE WHEN action = 'dislike' THEN 1 ELSE 0 END) AS dislike_count,
           SUM(CASE WHEN action = 'like' THEN 1 ELSE 0 END) AS like_count,
           MAX(CASE
             WHEN (action = 'play' AND played_ratio IS NULL)
               OR (action IN ('play', 'complete', 'skip') AND played_ratio >= 0.5)
             THEN played_at ELSE NULL END) AS last_played_at,
           MAX(CASE WHEN action = 'skip' THEN played_at ELSE NULL END) AS last_skipped_at,
           MAX(CASE WHEN action = 'dislike' THEN played_at ELSE NULL END) AS last_disliked_at,
           MAX(CASE WHEN action = 'like' THEN played_at ELSE NULL END) AS last_liked_at
    FROM listening_history lh
    JOIN tracks t ON t.id = lh.track_id
    WHERE lh.user_id = $userId OR (lh.user_id IS NULL AND $userId IS NULL)
    GROUP BY lh.track_id, t.artist, t.title
  `).all({ $userId: userId }) as Array<{
    track_id: string;
    artist: string;
    title: string;
    positive_count: number;
    early_skip_count: number;
    dislike_count: number;
    like_count: number;
    last_played_at: number | null;
    last_skipped_at: number | null;
    last_disliked_at: number | null;
     last_liked_at: number | null;
  }>;
  const userStats = new Map<string, UserTrackStats>();
  const userArtistStats = new Map<string, UserArtistStats>();
  for (const row of userStatRows) {
    const key = canonicalSongKey({ artist: row.artist, title: row.title });
    const existing = userStats.get(key);
    userStats.set(key, {
      positiveCount: (existing?.positiveCount ?? 0) + Number(row.positive_count ?? 0),
      earlySkipCount: (existing?.earlySkipCount ?? 0) + Number(row.early_skip_count ?? 0),
      lastPlayedAt: Math.max(existing?.lastPlayedAt ?? 0, Number(row.last_played_at ?? 0)) || null,
      lastSkippedAt: Math.max(existing?.lastSkippedAt ?? 0, Number(row.last_skipped_at ?? 0)) || null,
      lastDislikedAt: Math.max(existing?.lastDislikedAt ?? 0, Number(row.last_disliked_at ?? 0)) || null,
      lastLikedAt: Math.max(existing?.lastLikedAt ?? 0, Number(row.last_liked_at ?? 0)) || null,
    });
    const artistKey = normalizeArtistIdentity(row.artist);
    const existingArtist = userArtistStats.get(artistKey);
    userArtistStats.set(artistKey, {
      positiveCount: (existingArtist?.positiveCount ?? 0) + Number(row.positive_count ?? 0),
      earlySkipCount: (existingArtist?.earlySkipCount ?? 0) + Number(row.early_skip_count ?? 0),
      dislikeCount: (existingArtist?.dislikeCount ?? 0) + Number(row.dislike_count ?? 0),
      likeCount: (existingArtist?.likeCount ?? 0) + Number(row.like_count ?? 0),
      lastDislikedAt: Math.max(existingArtist?.lastDislikedAt ?? 0, Number(row.last_disliked_at ?? 0)) || null,
    });
  }

  const candidateTags = loadTrackTags(db, [...candidates.keys()]);
  const acceptedArtistKeys = new Set(
    (session?.acceptedSeeds ?? []).map((seed) => normalizeArtistIdentity(seed.artist)).filter(Boolean)
  );
  const acceptedIDs = (session?.acceptedSeeds ?? []).map((seed) => seed.id).filter((id): id is string => Boolean(id));
  const acceptedCfNeighbors = new Set<string>();
  if (acceptedIDs.length > 0) {
    const placeholders = acceptedIDs.map((_, index) => `$accepted${index}`).join(", ");
    const params = Object.fromEntries(acceptedIDs.map((id, index) => [`$accepted${index}`, id]));
    const rows = db.prepare(`
      SELECT other_id FROM similar_items
      WHERE track_id IN (${placeholders}) ORDER BY score DESC LIMIT 80
    `).all(params) as Array<{ other_id: string }>;
    rows.forEach((row) => acceptedCfNeighbors.add(row.other_id));
  }

  const latestModel = loadLatestRecoModel();
  const rankerMode = process.env.RECO_RANKER ?? "shadow";
  const modelUsable = latestModel != null && latestModel.auc >= 0.55;
  const useModelForRanking = rankerMode === "model" && modelUsable;
  const seedTagSet = new Set(seedTags.map(normalizePhrase));
  const orderedCandidates = options.deterministicSeed
    ? deterministicOrder([...candidates.values()], options.deterministicSeed, (candidate) => candidate.row.id)
    : shuffled([...candidates.values()]);
  const rankCandidates = (moodTerms: string[]): VibeTrackRow[] => orderedCandidates
    .map((candidate) => {
      const handScore = scoreVibeCandidate(candidate, {
        mode: options.mode,
        seedArtists,
        seedArtistSet,
        seedAlbums,
        seedGenres,
        seedMoods,
        seedKeywords,
        similarArtists,
        similarTitleKeywords,
        moodTerms,
        filters,
        userStats,
        userArtistStats,
        trackTags: candidateTags,
        acceptedArtistKeys,
        acceptedCfNeighbors,
        session,
      });
      if (handScore == null) return { row: candidate.row, score: null };
      const personal = userStats.get(canonicalSongKey(candidate.row));
      const artistPersonal = userArtistStats.get(normalizeArtistIdentity(candidate.row.artist));
      const hoursSincePlay = personal?.lastPlayedAt
        ? Math.max(0, (Date.now() / 1000 - personal.lastPlayedAt) / 3600)
        : 24 * 365;
      const hoursSinceSkip = personal?.lastSkippedAt
        ? Math.max(0, (Date.now() / 1000 - personal.lastSkippedAt) / 3600)
        : 24 * 365;
      const tags = candidateTags.get(candidate.row.id) ?? [];
      const tagOverlap = tags.filter((tag) => seedTagSet.has(normalizePhrase(tag))).length;
      const artistOverlap = Math.max(
        seedArtistSet.has(normalizePhrase(candidate.row.artist)) ? 1 : 0,
        ...seedArtists.map((seedArtist) => artistKeywordOverlap(candidate.row.artist, seedArtist))
      );
      const featureVector: RecoFeatureVector = {
        handScore,
        baseScore: candidate.baseScore,
        signalCount: candidate.signalCount,
        artistPositiveCount: artistPersonal?.positiveCount ?? 0,
        artistEarlySkipRate: artistPersonal
          ? (artistPersonal.positiveCount + artistPersonal.earlySkipCount) > 0
            ? artistPersonal.earlySkipCount / (artistPersonal.positiveCount + artistPersonal.earlySkipCount)
            : 0
          : 0,
        tagOverlap,
        cfSimilarity: cfSimilarities.get(candidate.row.id) ?? 0,
        familiar: personal?.positiveCount ? 1 : 0,
        logHoursSincePlay: Math.log1p(Math.min(hoursSincePlay, 24 * 365)),
        hoursSinceSkip: Math.min(hoursSinceSkip, 24 * 365),
        sourceScore: candidate.row.source === "local" ? 1 : candidate.row.source === "yandex" ? 0.8 : candidate.row.source === "soundcloud" ? 0.4 : 0.1,
        variantPenalty: trackVariantPenalty(candidate.row.title),
        moodMatchCount: fuzzyTagMatch(tags, moodTerms),
        seedArtistOverlap: artistOverlap,
        logPlayCount: Math.log1p(candidate.row.play_count),
      };
      const modelScore = modelUsable && latestModel ? predictRecoModel(latestModel, featureVector) : null;
      const decorated = {
        ...candidate.row,
        _recoHandScore: handScore,
        _recoModelScore: modelScore,
        _recoModelVersion: latestModel?.version,
        _recoFeatures: vectorFromFeatures(featureVector),
      } as VibeTrackRow;
      return { row: decorated, score: useModelForRanking && modelScore != null ? modelScore * 100 : handScore };
    })
    .filter((item): item is { row: VibeTrackRow; score: number } => item.score != null)
    .sort((lhs, rhs) =>
      rhs.score - lhs.score ||
      rhs.row.play_count - lhs.row.play_count ||
      (rhs.row.updated_at ?? 0) - (lhs.row.updated_at ?? 0) ||
      (options.deterministicSeed
        ? stableHash(`${options.deterministicSeed}:${lhs.row.id}`) - stableHash(`${options.deterministicSeed}:${rhs.row.id}`)
        : 0) ||
      lhs.row.id.localeCompare(rhs.row.id)
    )
    .map((item) => item.row);

  const strictRanked = balanceFamiliarity(
    rankCandidates(requestedMoodTerms),
    userStats,
    candidates,
    limit,
    options.mode,
    filters.character
  );
  const strictTracks = selectDiverseTracks(strictRanked, limit, {
    mode: options.mode,
    seedArtists,
    filters,
    queueTail: session?.queueTail,
  });

  if (strictTracks.length >= limit || requestedMoodTerms.length === 0) {
    return { tracks: strictTracks.slice(0, limit), filters, seedCount: seeds.length };
  }

  const seen = new Set(strictTracks.map((track) => track.id));
  const seenFamilies = new Set(strictTracks.map(canonicalSongKey));
  const fallbackRanked = balanceFamiliarity(
    rankCandidates([]),
    userStats,
    candidates,
    limit * 2,
    options.mode,
    filters.character
  );
  const fallbackTracks = selectDiverseTracks(fallbackRanked, limit * 2, {
    mode: options.mode,
    seedArtists,
    filters,
    queueTail: session?.queueTail,
  }).filter((track) => {
    const family = canonicalSongKey(track);
    if (seen.has(track.id) || seenFamilies.has(family)) return false;
    seen.add(track.id);
    seenFamilies.add(family);
    return true;
  });

  return {
    tracks: [...strictTracks, ...fallbackTracks].slice(0, limit),
    filters,
    seedCount: seeds.length,
  };
}
