/**
 * AI Music Recommendations Routes
 *
 * GET  /api/recommendations/taste-profile  — weighted taste profile from listening history
 * GET  /api/recommendations/home           — personalized home feed
 * GET  /api/recommendations/daily-mix      — Spotify-style Daily Mix (time-of-day aware)
 * GET  /api/recommendations/discover       — Discover Weekly: new tracks from similar artists
 * GET  /api/recommendations/mood?mood=X    — mood/genre-based track list
 * GET  /api/recommendations/similar        — Last.fm similar tracks matched to local library
 * POST /api/recommendations/chat           — conversational AI via OpenRouter
 * POST /api/recommendations/scrobble       — log a play event
 */

import { Hono } from "hono";
import { getDb, logListening } from "../db/index.js";
import {
  buildWeightedProfile,
  buildDailyMix,
  getTimeContextArtists,
  getTracksByMood,
  getCached,
  setCached,
  isDiscoverableRow,
  userCacheKey,
  clearUserRecommendationCaches,
} from "../providers/taste-engine.js";
import { getYandexProvider } from "../providers/yandex.js";
import { getYouTubeProvider } from "../providers/youtube.js";
import {
  baseTrackTitle,
  normalizeArtistIdentity,
  songFamilyKey,
  trackVariantPenalty,
} from "../utils/track-identity.js";

const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "minimax/minimax-m2.5:free";
const OPENROUTER_TIMEOUT_MS = 15_000;
const YANDEX_WAVE_CACHE_KEY = "catalog-warm:yandex-wave";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLastfmKey(): string | null {
  return process.env.LASTFM_API_KEY ?? null;
}

function getOpenRouterKey(): string | null {
  return process.env.OPENROUTER_API_KEY ?? null;
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

interface VibeSeed {
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

interface VibeFilters {
  language?: "russian" | "foreign";
  character?: "favorite" | "unfamiliar" | "popular";
  mood?: string;
}

interface VibeTrackRow extends Record<string, unknown> {
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
}

interface SimilarTrackSignal {
  artist: string;
  title: string;
  match: number;
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

function normalizePhrase(value: string | null | undefined): string {
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

function normalizeTrackRow(row: Record<string, unknown>): VibeTrackRow {
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

function collapseTrackVariants<T extends Record<string, unknown>>(tracks: T[]): T[] {
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

function requestUserId(c: unknown): string | null {
  return ((c as any).get("userId") as string | undefined) ?? null;
}

function recommendationRequestId(): string {
  return crypto.randomUUID();
}

function recommendationEnvelope(
  payload: Record<string, unknown>,
  surface: string,
  userId: string | null
): Record<string, unknown> {
  const requestId = recommendationRequestId();
  const rawTracks = Array.isArray(payload.tracks)
    ? payload.tracks.filter((track): track is Record<string, unknown> => Boolean(track && typeof track === "object"))
    : [];
  const tracks = collapseTrackVariants(rawTracks);
  const responsePayload = typeof payload.count === "number"
    ? { ...payload, tracks, count: tracks.length }
    : { ...payload, tracks };
  const db = getDb();
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO recommendation_impressions
        (request_id, user_id, surface, track_id, position)
      VALUES ($requestId, $userId, $surface, $trackId, $position)
    `);
    tracks.forEach((track, position) => {
      if (!track || typeof track !== "object") return;
      const trackId = String((track as Record<string, unknown>).id ?? "").trim();
      if (!trackId) return;
      insert.run({
        $requestId: requestId,
        $userId: userId,
        $surface: surface,
        $trackId: trackId,
        $position: position,
      });
    });
  })();
  return { ...responsePayload, requestId };
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

function matchesMoodFilter(row: VibeTrackRow, moodTerms: string[]): boolean {
  if (moodTerms.length === 0) return true;
  const text = normalizePhrase(`${row.title} ${row.artist} ${row.album ?? ""} ${row.genre ?? ""} ${row.mood ?? ""}`);
  const tags = [
    ...splitTagField(row.genre).map(normalizePhrase),
    ...splitTagField(row.mood).map(normalizePhrase),
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
  }
): number | null {
  const row = candidate.row;
  const personal = context.userStats.get(canonicalSongKey(row));
  if (personal?.lastDislikedAt && personal.lastDislikedAt > (personal.lastLikedAt ?? 0)) return null;
  if (!matchesLanguageFilter(row, context.filters.language)) return null;
  if (!matchesMoodFilter(row, context.moodTerms)) return null;

  const artist = normalizePhrase(row.artist);
  const artistPersonal = context.userArtistStats.get(normalizeArtistIdentity(row.artist));
  const album = normalizePhrase(row.album);
  const text = normalizePhrase(`${row.title} ${row.artist} ${row.album ?? ""}`);
  const tags = [
    ...splitTagField(row.genre).map(normalizePhrase),
    ...splitTagField(row.mood).map(normalizePhrase),
  ];

  let score = candidate.baseScore * 4.4 + candidate.signalCount * 1.6;
  score += fuzzyListMatch(artist, context.seedArtists) * 1.8;
  score += fuzzyListMatch(album, context.seedAlbums) * 3.2;
  score += fuzzyListMatch(text, context.seedKeywords) * 2.2;
  score += fuzzyListMatch(text, context.similarTitleKeywords) * 3.1;
  score += fuzzyListMatch(artist, context.similarArtists) * 1.7;
  score += fuzzyTagMatch(tags, context.seedGenres) * 4;
  score += fuzzyTagMatch(tags, context.seedMoods) * 3.6;

  if (artistPersonal) {
    const dislikeBalance = Math.max(0, artistPersonal.dislikeCount - artistPersonal.likeCount);
    score -= Math.min(30, dislikeBalance * 12);
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

function querySimilarTrackMatches(db: ReturnType<typeof getDb>, signal: SimilarTrackSignal): VibeTrackRow[] {
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

function selectDiverseTracks(
  rankedRows: VibeTrackRow[],
  limit: number,
  context: {
    mode: StationMode;
    seedArtists: string[];
    filters: Required<Pick<VibeFilters, "character">> & VibeFilters;
  }
): VibeTrackRow[] {
  const familySafeRows = collapseTrackVariants(rankedRows);
  const selected: VibeTrackRow[] = [];
  const selectedIDs = new Set<string>();
  const selectedTitles = new Set<string>();
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

// OpenRouter simple rate limiter (token bucket: 10 req/min)
let openrouterTokens = 10;
let openrouterLastRefill = Date.now();
const OPENROUTER_MAX_TOKENS = 10;

function consumeOpenRouterToken(): boolean {
  const now = Date.now();
  if (now - openrouterLastRefill >= 60_000) {
    openrouterTokens = OPENROUTER_MAX_TOKENS;
    openrouterLastRefill = now;
  }
  if (openrouterTokens <= 0) return false;
  openrouterTokens--;
  return true;
}

function profileSeeds(profile: ReturnType<typeof buildWeightedProfile>, limit = 6): VibeSeed[] {
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
  const discoveryRatio = mode === "auto_mix"
    ? 0.45
    : character === "unfamiliar"
      ? 0.7
      : character === "popular"
        ? 0.2
        : 0.3;
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

async function getSimilarTracksFromLastfm(seeds: VibeSeed[]): Promise<SimilarTrackSignal[]> {
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

const catalogWarmInFlight = new Map<string, Promise<void>>();

async function warmExternalCandidateCatalog(
  seedArtists: string[],
  similarSignals: SimilarTrackSignal[]
): Promise<void> {
  const warmKey = `catalog-warm:${seedArtists.slice(0, 2).join("|")}:${similarSignals
    .slice(0, 8)
    .map((signal) => `${signal.artist}:${signal.title}`)
    .join("|")}`.toLowerCase();
  if (getCached<boolean>(warmKey)) return;
  const existingWarm = catalogWarmInFlight.get(warmKey);
  if (existingWarm) return existingWarm;

  const db = getDb();
  const yandexProvider = getYandexProvider();
  const provider = yandexProvider.isAuthenticated() ? yandexProvider : getYouTubeProvider();

  const warm = (async () => {
    // Populate a small slice of the real provider catalogue instead of limiting
    // recommendations to tracks that happened to be cached by previous searches.
    const artistTasks = seedArtists.slice(0, 2).map(async (artist) => {
      const count = (db.prepare(
        "SELECT COUNT(*) AS n FROM tracks WHERE lower(artist) LIKE lower($artist)"
      ).get({ $artist: `%${artist}%` }) as { n: number }).n;
      if (count < 6) await provider.getArtistTracks(artist);
    });

    const signalTasks = similarSignals.slice(0, 8).map(async (signal) => {
      if (querySimilarTrackMatches(db, signal).length > 0) return;
      await provider.search(`${signal.artist} ${signal.title}`, 5, 0);
    });

    const stationTasks: Promise<unknown>[] = [];
    if (yandexProvider.isAuthenticated()
      && !getCached<Array<Record<string, unknown>>>(YANDEX_WAVE_CACHE_KEY)) {
      stationTasks.push(
        yandexProvider.getStationTracks("user:onyourwave", 60).then((tracks) => {
          setCached(YANDEX_WAVE_CACHE_KEY, tracks.map((track) => ({ ...track })), 15 * 60_000);
        })
      );
    }

    await Promise.allSettled([...artistTasks, ...signalTasks, ...stationTasks]);
    setCached(warmKey, true, 15 * 60_000);
  })();
  catalogWarmInFlight.set(warmKey, warm);
  try {
    await warm;
  } finally {
    catalogWarmInFlight.delete(warmKey);
  }
}

async function buildStationTracks(options: {
  mode: StationMode;
  seeds: VibeSeed[];
  excludeIds?: string[];
  limit?: number;
  filters?: VibeFilters;
  userId?: string | null;
}): Promise<{
  tracks: VibeTrackRow[];
  filters: Required<Pick<VibeFilters, "character">> & VibeFilters;
  seedCount: number;
}> {
  const db = getDb();
  const requestedLimit = Number(options.limit ?? 24);
  const limit = Number.isFinite(requestedLimit) ? Math.max(8, Math.min(Math.floor(requestedLimit), 60)) : 24;
  const seeds = options.seeds;
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

  if (seedIDs.length > 0) {
    const placeholders = seedIDs.map((_, index) => `$seed${index}`).join(", ");
    const params = Object.fromEntries(seedIDs.map((id, index) => [`$seed${index}`, id]));
    const rows = db.prepare(`SELECT genre, mood FROM tracks WHERE id IN (${placeholders})`).all(params) as VibeMetadataRow[];
    seedGenres = uniqueStrings(rows.flatMap((row) => splitTagField(row.genre)), 8).map(normalizePhrase);
    seedMoods = uniqueStrings(rows.flatMap((row) => splitTagField(row.mood)), 8).map(normalizePhrase);
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

  const similarTrackSignals = await getSimilarTracksFromLastfm(seeds);
  await warmExternalCandidateCatalog(seedArtists, similarTrackSignals);
  const similarArtists = uniqueStrings(similarTrackSignals.map((track) => track.artist), 12).map(normalizePhrase);
  const similarTitleKeywords = extractVibeKeywords(similarTrackSignals.map((track) => track.title), 16);

  const candidates = new Map<string, RankedVibeCandidate>();
  const addCandidates = (rows: Array<Record<string, unknown>>, score: number) => {
    for (const row of rows) {
      const normalizedRow = normalizeTrackRow(row);
      const id = normalizedRow.id;
      if (!id || exclude.has(id) || excludedSongKeys.has(canonicalSongKey(normalizedRow))) continue;
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

  const waveCandidates = getCached<Array<Record<string, unknown>>>(YANDEX_WAVE_CACHE_KEY) ?? [];
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
    addCandidates(rows, 0);
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
    });
  }

  const rankCandidates = (moodTerms: string[]): VibeTrackRow[] => shuffled([...candidates.values()])
    .map((candidate) => ({
      row: candidate.row,
      score: scoreVibeCandidate(candidate, {
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
      }),
    }))
    .filter((item): item is { row: VibeTrackRow; score: number } => item.score != null)
    .sort((lhs, rhs) =>
      rhs.score - lhs.score ||
      rhs.row.play_count - lhs.row.play_count ||
      (rhs.row.updated_at ?? 0) - (lhs.row.updated_at ?? 0)
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

// ─── Router ───────────────────────────────────────────────────────────────────

export const recommendationsRouter = new Hono();

/**
 * GET /api/recommendations/taste-profile
 */
recommendationsRouter.get("/taste-profile", (c) => {
  const userId = requestUserId(c);
  const cacheKey = userCacheKey("taste-profile", userId);
  const cached = getCached<unknown>(cacheKey);
  if (cached) return c.json(cached);

  const profile = buildWeightedProfile(userId);
  const response = {
    topArtists: profile.topArtists.slice(0, 10).map((a) => a.artist),
    topTracks: profile.topTracks.slice(0, 20),
    topGenres: profile.topGenres,
    topMoods: profile.topMoods,
    playCount: profile.playCount,
    completionRate: profile.completionRate,
    timeOfDayProfile: profile.timeOfDayProfile,
  };
  setCached(cacheKey, response, 5 * 60_000);
  return c.json(response);
});

/**
 * GET /api/recommendations/home
 * Personalized feed: taste profile + Last.fm similar artists.
 */
recommendationsRouter.get("/home", async (c) => {
  const userId = requestUserId(c);
  const cacheKey = userCacheKey("home", userId);
  const cached = getCached<Record<string, unknown>>(cacheKey);
  if (cached) return c.json(recommendationEnvelope(cached, "home", userId));

  const profile = buildWeightedProfile(userId);
  const db = getDb();

  if (profile.playCount === 0) {
    const yandexProvider = getYandexProvider();
    if (yandexProvider.isAuthenticated()) {
      // A connected account provides a much stronger cold start than global
      // cache popularity. Failure remains non-fatal for offline operation.
      await yandexProvider.getStationTracks("user:onyourwave", 60).catch(() => []);
    }
    const rows = (db.prepare(`
      SELECT * FROM tracks
      WHERE source <> 'vk'
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 120
    `).all() as Record<string, unknown>[]).map(normalizeTrackRow);
    const tracks = selectDiverseTracks(rows, 20, {
      mode: "my_vibe",
      seedArtists: [],
      filters: { character: "popular" },
    });
    const result = { tracks, source: "cold_start_popular" };
    setCached(cacheKey, result, 5 * 60_000);
    return c.json(recommendationEnvelope(result, "home", userId));
  }

  const station = await buildStationTracks({
    mode: "my_vibe",
    seeds: profileSeeds(profile),
    limit: 20,
    filters: { character: "favorite" },
    userId,
  });

  const result = {
    tracks: station.tracks,
    profile: { topArtists: profile.topArtists.slice(0, 5).map((artist) => artist.artist), playCount: profile.playCount },
    source: "personalized_ranker",
  };
  setCached(cacheKey, result, 10 * 60_000);
  return c.json(recommendationEnvelope(result, "home", userId));
});

/**
 * GET /api/recommendations/daily-mix
 * Time-of-day aware playlist blending favorites + discovery.
 */
recommendationsRouter.get("/daily-mix", async (c) => {
  const userId = requestUserId(c);
  const cacheKey = userCacheKey("daily-mix", userId);
  const refresh = c.req.query("refresh") === "1";
  if (!refresh) {
    const cached = getCached<Record<string, unknown>>(cacheKey);
    if (cached) return c.json(recommendationEnvelope(cached, "daily_mix", userId));
  }

  const profile = buildWeightedProfile(userId);
  const station = await buildStationTracks({
    mode: "my_vibe",
    seeds: profileSeeds(profile, 8),
    limit: 20,
    filters: { character: "favorite" },
    userId,
  });

  const hour = new Date().getHours();
  const name =
    hour < 12 ? "Morning Mix" :
    hour < 18 ? "Afternoon Mix" :
    hour < 22 ? "Evening Mix" : "Late Night Mix";

  const result = {
    name,
    tracks: station.tracks,
    source: "daily_mix",
    refreshAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  };
  setCached(cacheKey, result, 6 * 3600_000);
  return c.json(recommendationEnvelope(result, "daily_mix", userId));
});

/**
 * POST /api/recommendations/my-vibe
 * Builds a queue around liked tracks passed by the iOS client.
 */
recommendationsRouter.post("/my-vibe", async (c) => {
  const userId = requestUserId(c);
  const body = await c.req.json<{
    seeds?: VibeSeed[];
    excludeIds?: string[];
    limit?: number;
    filters?: VibeFilters;
  }>();
  const result = await buildStationTracks({
    mode: "my_vibe",
    seeds: body.seeds ?? [],
    excludeIds: body.excludeIds ?? [],
    limit: body.limit,
    filters: body.filters,
    userId,
  });

  return c.json(recommendationEnvelope({
    tracks: result.tracks,
    source: "my_vibe",
    seedCount: result.seedCount,
    filters: result.filters,
  }, "my_vibe", userId));
});

recommendationsRouter.post("/auto-mix", async (c) => {
  const userId = requestUserId(c);
  const body = await c.req.json<{
    seeds?: VibeSeed[];
    excludeIds?: string[];
    limit?: number;
  }>();

  const result = await buildStationTracks({
    mode: "auto_mix",
    seeds: body.seeds ?? [],
    excludeIds: body.excludeIds ?? [],
    limit: body.limit ?? 20,
    userId,
  });

  return c.json(recommendationEnvelope({
    tracks: result.tracks,
    source: "auto_mix",
    seedCount: result.seedCount,
  }, "auto_mix", userId));
});

/**
 * GET /api/recommendations/discover
 * Discover Weekly: tracks from similar artists not in top plays.
 */
recommendationsRouter.get("/discover", async (c) => {
  const userId = requestUserId(c);
  const cacheKey = userCacheKey("discover", userId);
  const cached = getCached<Record<string, unknown>>(cacheKey);
  if (cached) return c.json(recommendationEnvelope(cached, "discover", userId));

  const profile = buildWeightedProfile(userId);
  const station = await buildStationTracks({
    mode: "my_vibe",
    seeds: profileSeeds(profile, 10),
    limit: 20,
    filters: { character: "unfamiliar" },
    userId,
  });
  const result = {
    tracks: station.tracks,
    source: "personalized_discovery",
    description: "New tracks connected to your taste",
  };
  setCached(cacheKey, result, 24 * 3600_000);
  return c.json(recommendationEnvelope(result, "discover", userId));
});

/**
 * GET /api/recommendations/mood?mood=X&limit=N
 */
recommendationsRouter.get("/mood", async (c) => {
  const mood = c.req.query("mood") ?? "";
  const requestedLimit = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.floor(requestedLimit), 50)) : 20;
  if (!mood) return c.json({ error: "mood parameter required" }, 400);

  const userId = requestUserId(c);
  const profile = buildWeightedProfile(userId);
  const station = await buildStationTracks({
    mode: "my_vibe",
    seeds: profileSeeds(profile),
    limit,
    filters: { character: "favorite", mood },
    userId,
  });
  const tracks = station.tracks.length > 0
    ? station.tracks.slice(0, limit)
    : getTracksByMood(mood, limit, userId);
  return c.json(recommendationEnvelope({ tracks, mood, count: tracks.length }, "mood", userId));
});

/**
 * GET /api/recommendations/similar?artist=X&track=Y
 */
recommendationsRouter.get("/similar", async (c) => {
  const artist = c.req.query("artist");
  const track = c.req.query("track");
  if (!artist || !track) return c.json({ error: "artist and track required" }, 400);

  const cacheKey = `similar:${artist}:${track}`;
  const cached = getCached<unknown>(cacheKey);
  if (cached) return c.json(cached);

  if (!getLastfmKey()) return c.json({ tracks: [], note: "LASTFM_API_KEY not configured" });

  try {
    const similar = await getSimilarTracksFromLastfm([{ artist, title: track }]);
    if (similar.length === 0) return c.json({ tracks: [] });

    const db = getDb();
    const matched: Array<Record<string, unknown>> = [];
    const matchedIDs = new Set<string>();
    for (const signal of similar.slice(0, 20)) {
      for (const row of querySimilarTrackMatches(db, signal)) {
        if (matchedIDs.has(row.id)) continue;
        matchedIDs.add(row.id);
        matched.push({ ...row, _reason: `Similar to ${artist} - ${track}` });
        if (matched.length >= 10) break;
      }
      if (matched.length >= 10) break;
    }

    const result = {
      tracks: matched,
      similar: similar.slice(0, 5).map((s) => ({ artist: s.artist, track: s.title })),
    };
    setCached(cacheKey, result, 30 * 60_000);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message, tracks: [] }, 500);
  }
});

/**
 * GET /api/recommendations/quality?days=30
 * Behavioural guardrails for evaluating recommendation changes. These are
 * intentionally computed from recommendation surfaces only.
 */
recommendationsRouter.get("/quality", (c) => {
  const userId = requestUserId(c);
  const requestedDays = Number(c.req.query("days") ?? 30);
  const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(Math.floor(requestedDays), 365)) : 30;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(CASE WHEN action IN ('play', 'complete', 'skip') THEN 1 END) AS playback_events,
      COUNT(CASE WHEN action = 'skip' AND COALESCE(played_ratio, 0) < 0.2 THEN 1 END) AS early_skips,
      COUNT(CASE WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.8 THEN 1 END) AS long_listens,
      COUNT(CASE WHEN action = 'like' THEN 1 END) AS likes,
      COUNT(DISTINCT CASE
        WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.5 THEN track_id
        ELSE NULL END) AS accepted_tracks,
      COUNT(DISTINCT CASE
        WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.5 THEN session_id
        ELSE NULL END) AS sessions,
      COUNT(DISTINCT CASE
        WHEN action = 'complete' OR COALESCE(played_ratio, 0) >= 0.5 THEN request_id
        ELSE NULL END) AS accepted_requests
    FROM listening_history
    WHERE played_at >= $cutoff
      AND surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix')
      AND (user_id = $userId OR (user_id IS NULL AND $userId IS NULL))
  `).get({ $cutoff: cutoff, $userId: userId }) as {
    playback_events: number;
    early_skips: number;
    long_listens: number;
    likes: number;
    accepted_tracks: number;
    sessions: number;
    accepted_requests: number;
  };
  const impressions = db.prepare(`
    SELECT COUNT(*) AS impressions, COUNT(DISTINCT request_id) AS requests
    FROM recommendation_impressions
    WHERE created_at >= $cutoff
      AND surface IN ('home', 'daily_mix', 'mood', 'my_vibe', 'auto_mix', 'discover')
      AND (user_id = $userId OR (user_id IS NULL AND $userId IS NULL))
  `).get({ $cutoff: cutoff, $userId: userId }) as { impressions: number; requests: number };
  const playbackEvents = Number(row.playback_events ?? 0);
  const requestCount = Number(impressions.requests ?? 0);
  return c.json({
    days,
    impressions: Number(impressions.impressions ?? 0),
    requests: requestCount,
    playbackEvents,
    earlySkipRate: playbackEvents > 0 ? Number(row.early_skips ?? 0) / playbackEvents : 0,
    longListenRate: playbackEvents > 0 ? Number(row.long_listens ?? 0) / playbackEvents : 0,
    likes: Number(row.likes ?? 0),
    acceptedTracks: Number(row.accepted_tracks ?? 0),
    sessions: Number(row.sessions ?? 0),
    acceptedRequestRate: requestCount > 0 ? Number(row.accepted_requests ?? 0) / requestCount : 0,
  });
});

/**
 * POST /api/recommendations/chat
 */
recommendationsRouter.post("/chat", async (c) => {
  const body = await c.req.json<{
    message: string;
    history?: Array<{ role: string; content: string }>;
  }>();
  if (!body.message) return c.json({ error: "message required" }, 400);

  const key = getOpenRouterKey();
  if (!key) return c.json({ error: "OPENROUTER_API_KEY not configured. Add it to server/.env" }, 503);

  if (!consumeOpenRouterToken()) {
    return c.json({ error: "AI rate limit reached. Try again in a minute." }, 429);
  }

  const db = getDb();
  const profile = buildWeightedProfile(requestUserId(c));
  const stats = db.prepare(
    "SELECT COUNT(*) as total, COUNT(DISTINCT artist) as artists FROM tracks WHERE source = 'local'"
  ).get() as { total: number; artists: number };

  const systemPrompt = `You are Musaic AI, a music discovery assistant for a local music player.

User taste: Top artists: ${profile.topArtists.slice(0, 8).map((a) => a.artist).join(", ") || "None yet"} | Genres: ${profile.topGenres.slice(0, 5).map((g) => g.genre).join(", ") || "Unknown"} | Moods: ${profile.topMoods.slice(0, 5).map((m) => m.mood).join(", ") || "Unknown"} | Plays: ${profile.playCount}

Library: ${stats.total} tracks, ${stats.artists} artists. Be concise and enthusiastic.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...(body.history ?? []),
    { role: "user", content: body.message },
  ];

  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://musaic.app",
        "X-Title": "Musaic",
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: 500, temperature: 0.8 }),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    });

    if (!res.ok) {
      openrouterTokens = Math.min(openrouterTokens + 1, OPENROUTER_MAX_TOKENS);
      return c.json({ error: `AI service error: ${res.status}`, fallback: "Please try again shortly." }, 500);
    }

    const data = await res.json() as { choices?: Array<{ message: { content: string } }> };
    const reply = data.choices?.[0]?.message?.content ?? "Sorry, I couldn't generate a response.";
    return c.json({ reply });
  } catch (err: unknown) {
    openrouterTokens = Math.min(openrouterTokens + 1, OPENROUTER_MAX_TOKENS);
    return c.json({ error: (err as Error).message, fallback: "AI is temporarily unavailable." }, 500);
  }
});

/**
 * POST /api/recommendations/scrobble
 */
recommendationsRouter.post("/scrobble", async (c) => {
  const body = await c.req.json<{
    trackId: string;
    action?: string;
    eventId?: string;
    playedMs?: number;
    durationMs?: number;
    playedRatio?: number;
    sessionId?: string;
    requestId?: string;
    surface?: string;
    isOrganic?: boolean;
    position?: number;
  }>();
  if (!body.trackId) return c.json({ error: "trackId required" }, 400);

  const action = body.action ?? "play";
  const validActions = new Set(["play", "pause", "skip", "like", "unlike", "dislike", "complete"]);
  if (!validActions.has(action)) return c.json({ error: "Invalid action" }, 400);
  const userId = requestUserId(c);
  const inserted = logListening(body.trackId, action, userId, body);
  clearUserRecommendationCaches(userId);

  return c.json({ ok: true, inserted });
});
