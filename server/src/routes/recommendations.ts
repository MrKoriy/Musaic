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
import { getDb } from "../db/index.js";
import {
  buildWeightedProfile,
  buildDailyMix,
  getTracksByMood,
  getCached,
  setCached,
  clearCached,
} from "../providers/taste-engine.js";

const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "minimax/minimax-m2.5:free";
const OPENROUTER_TIMEOUT_MS = 15_000;

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
  feelgood: ["feel good", "feelgood", "happy", "sunny", "bright", "positive", "светло", "радость", "позитив"],
  calm: ["relax", "calm", "chill", "sleep", "ambient", "спокойно", "сон", "тихо", "мягко"],
  focus: ["focus", "study", "work", "deep", "concentration", "фокус", "учеба", "работа", "концентрация"],
  romance: ["romance", "romantic", "love", "date", "романтика", "любовь"],
  sad: ["sad", "melancholy", "cry", "грусть", "меланхолия", "печаль"],
  party: ["party", "club", "dance", "вечеринка", "клуб", "танцы"],
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
  }
): number | null {
  const row = candidate.row;
  if (!matchesLanguageFilter(row, context.filters.language)) return null;
  if (!matchesMoodFilter(row, context.moodTerms)) return null;

  const artist = normalizePhrase(row.artist);
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

  const playCount = row.play_count;
  const lastPlayedAt = row.last_played_at ?? 0;
  const hoursSinceLastPlay = lastPlayedAt > 0 ? (Date.now() / 1000 - lastPlayedAt) / 3600 : Number.POSITIVE_INFINITY;

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
        score += Math.min(playCount, 24) * 1.9;
        if (hoursSinceLastPlay < 24 * 21) score += 1.5;
        break;
    }
  }

  score += Math.min((row.updated_at ?? 0) / 1_000_000_000, 2);
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
    for (const row of rankedRows) {
      if (selected.length >= limit) return selected;
      if (selectedIDs.has(row.id)) continue;

      const artistKey = normalizeArtistKey(row.artist);
      const titleKey = `${artistKey}::${normalizeTitleKey(row.title)}`;
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
  }

  for (const row of rankedRows) {
    if (selected.length >= limit) break;
    if (selectedIDs.has(row.id)) continue;
    selected.push(row);
    selectedIDs.add(row.id);
  }

  return selected;
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

async function getSimilarArtistsFromLastfm(artists: string[]): Promise<string[]> {
  const similar = new Set<string>();
  for (const artist of artists.slice(0, 3)) {
    try {
      const data = await lastfmGet({ method: "artist.getSimilar", artist, limit: "5" }) as {
        similarartists?: { artist?: Array<{ name: string }> }
      };
      (data.similarartists?.artist ?? []).forEach((a) => similar.add(a.name));
    } catch { /* skip */ }
  }
  return [...similar];
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

async function buildStationTracks(options: {
  mode: StationMode;
  seeds: VibeSeed[];
  excludeIds?: string[];
  limit?: number;
  filters?: VibeFilters;
}): Promise<{
  tracks: VibeTrackRow[];
  filters: Required<Pick<VibeFilters, "character">> & VibeFilters;
  seedCount: number;
}> {
  const db = getDb();
  const limit = Math.max(8, Math.min(Number(options.limit ?? 24), 60));
  const seeds = options.seeds;
  const exclude = new Set<string>(options.excludeIds ?? []);
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
    const profile = buildWeightedProfile();
    seedArtists.push(...uniqueStrings(profile.topArtists.map((artist) => artist.artist), 6).map(normalizePhrase));
    seedGenres.push(...uniqueStrings(profile.topGenres.map((genre) => genre.genre), 4).map(normalizePhrase));
    seedMoods.push(...uniqueStrings(profile.topMoods.map((mood) => mood.mood), 4).map(normalizePhrase));
  }

  if (requestedMoodTerms.length > 0) {
    seedMoods = uniqueStrings([...seedMoods, ...requestedMoodTerms], 10).map(normalizePhrase);
  }

  const seedArtistSet = new Set(seedArtists);

  const similarTrackSignals = await getSimilarTracksFromLastfm(seeds);
  const similarArtists = uniqueStrings(similarTrackSignals.map((track) => track.artist), 12).map(normalizePhrase);
  const similarTitleKeywords = extractVibeKeywords(similarTrackSignals.map((track) => track.title), 16);

  const candidates = new Map<string, RankedVibeCandidate>();
  const addCandidates = (rows: Array<Record<string, unknown>>, score: number) => {
    for (const row of rows) {
      const normalizedRow = normalizeTrackRow(row);
      const id = normalizedRow.id;
      if (!id || exclude.has(id)) continue;
      const existing = candidates.get(id);
      if (existing) {
        existing.baseScore += score;
        existing.signalCount += 1;
      } else {
        candidates.set(id, { row: normalizedRow, baseScore: score, signalCount: 1 });
      }
    }
  };

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
    const profile = buildWeightedProfile();
    addCandidates(buildDailyMix(profile), 1);
  }

  if (candidates.size < limit * 3) {
    const rows = db.prepare(`
      SELECT * FROM tracks
      ORDER BY play_count DESC, updated_at DESC
      LIMIT 140
    `).all() as Record<string, unknown>[];
    addCandidates(rows, 0);
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
      }),
    }))
    .filter((item): item is { row: VibeTrackRow; score: number } => item.score != null)
    .sort((lhs, rhs) =>
      rhs.score - lhs.score ||
      rhs.row.play_count - lhs.row.play_count ||
      (rhs.row.updated_at ?? 0) - (lhs.row.updated_at ?? 0)
    )
    .map((item) => item.row);

  const strictTracks = selectDiverseTracks(rankCandidates(requestedMoodTerms), limit, {
    mode: options.mode,
    seedArtists,
    filters,
  });

  if (strictTracks.length >= limit || requestedMoodTerms.length === 0) {
    return { tracks: strictTracks.slice(0, limit), filters, seedCount: seeds.length };
  }

  const seen = new Set(strictTracks.map((track) => track.id));
  const fallbackTracks = selectDiverseTracks(rankCandidates([]), limit * 2, {
    mode: options.mode,
    seedArtists,
    filters,
  }).filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
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
  const cached = getCached<unknown>("taste-profile");
  if (cached) return c.json(cached);

  const profile = buildWeightedProfile();
  const response = {
    topArtists: profile.topArtists.slice(0, 10).map((a) => a.artist),
    topTracks: profile.topTracks.slice(0, 20),
    topGenres: profile.topGenres,
    topMoods: profile.topMoods,
    playCount: profile.playCount,
    completionRate: profile.completionRate,
    timeOfDayProfile: profile.timeOfDayProfile,
  };
  setCached("taste-profile", response, 5 * 60_000);
  return c.json(response);
});

/**
 * GET /api/recommendations/home
 * Personalized feed: taste profile + Last.fm similar artists.
 */
recommendationsRouter.get("/home", async (c) => {
  const cached = getCached<unknown>("home");
  if (cached) return c.json(cached);

  const profile = buildWeightedProfile();
  const db = getDb();

  if (profile.playCount === 0) {
    const rows = db.prepare("SELECT * FROM tracks WHERE source = 'local' ORDER BY RANDOM() LIMIT 20").all();
    const result = { tracks: rows, source: "random" };
    setCached("home", result, 5 * 60_000);
    return c.json(result);
  }

  const topArtistNames = profile.topArtists.slice(0, 5).map((a) => a.artist);

  let discoverArtists: string[] = [];
  if (getLastfmKey()) {
    try {
      discoverArtists = await getSimilarArtistsFromLastfm(topArtistNames);
    } catch { /* skip */ }
  }

  const newArtists = discoverArtists.filter((a) => !topArtistNames.includes(a)).slice(0, 8);
  let recommendations: unknown[] = [];

  if (newArtists.length > 0) {
    const placeholders = newArtists.map((_, i) => `$a${i}`).join(", ");
    const params: Record<string, string> = {};
    newArtists.forEach((a, i) => { params[`$a${i}`] = `%${a.toLowerCase()}%`; });
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY lower(artist) ORDER BY RANDOM()) as rn
        FROM tracks WHERE ${newArtists.map((_, i) => `lower(artist) LIKE $a${i}`).join(" OR ")}
      ) WHERE rn <= 2 LIMIT 15
    `).all(params) as unknown[];
    recommendations = rows;
  }

  if (recommendations.length < 10 && topArtistNames.length > 0) {
    const fav = topArtistNames[Math.floor(Math.random() * Math.min(3, topArtistNames.length))];
    const rows = db.prepare(
      "SELECT * FROM tracks WHERE artist = $a ORDER BY RANDOM() LIMIT 5"
    ).all({ $a: fav }) as unknown[];
    recommendations.push(...rows);
  }

  const result = {
    tracks: recommendations.slice(0, 20),
    profile: { topArtists: topArtistNames, playCount: profile.playCount },
    source: getLastfmKey() ? "lastfm_similar" : "local_favorites",
  };
  setCached("home", result, 10 * 60_000);
  return c.json(result);
});

/**
 * GET /api/recommendations/daily-mix
 * Time-of-day aware playlist blending favorites + discovery.
 */
recommendationsRouter.get("/daily-mix", async (c) => {
  const refresh = c.req.query("refresh") === "1";
  if (!refresh) {
    const cached = getCached<unknown>("daily-mix");
    if (cached) return c.json(cached);
  }

  const profile = buildWeightedProfile();
  const topArtistNames = profile.topArtists.slice(0, 8).map((a) => a.artist);

  let discoverArtists: string[] = [];
  if (getLastfmKey()) {
    try {
      discoverArtists = await getSimilarArtistsFromLastfm(topArtistNames.slice(0, 2));
    } catch { /* skip */ }
  }
  const newArtists = discoverArtists.filter((a) => !topArtistNames.includes(a));
  const tracks = buildDailyMix(profile, newArtists);

  const hour = new Date().getHours();
  const name =
    hour < 12 ? "Morning Mix" :
    hour < 18 ? "Afternoon Mix" :
    hour < 22 ? "Evening Mix" : "Late Night Mix";

  const result = {
    name,
    tracks,
    source: "daily_mix",
    refreshAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  };
  setCached("daily-mix", result, 6 * 3600_000);
  return c.json(result);
});

/**
 * POST /api/recommendations/my-vibe
 * Builds a queue around liked tracks passed by the iOS client.
 */
recommendationsRouter.post("/my-vibe", async (c) => {
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
  });

  return c.json({
    tracks: result.tracks,
    source: "my_vibe",
    seedCount: result.seedCount,
    filters: result.filters,
  });
});

recommendationsRouter.post("/auto-mix", async (c) => {
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
  });

  return c.json({
    tracks: result.tracks,
    source: "auto_mix",
    seedCount: result.seedCount,
  });
});

/**
 * GET /api/recommendations/discover
 * Discover Weekly: tracks from similar artists not in top plays.
 */
recommendationsRouter.get("/discover", async (c) => {
  const cached = getCached<unknown>("discover");
  if (cached) return c.json(cached);

  const profile = buildWeightedProfile();
  const topArtistNames = profile.topArtists.slice(0, 10).map((a) => a.artist);
  const db = getDb();

  if (!getLastfmKey()) {
    const placeholders = topArtistNames.length > 0
      ? `WHERE artist NOT IN (${topArtistNames.map((_, i) => `$a${i}`).join(",")})` : "";
    const params = topArtistNames.length > 0
      ? Object.fromEntries(topArtistNames.map((a, i) => [`$a${i}`, a])) : {};
    const rows = db.prepare(`SELECT * FROM tracks ${placeholders} ORDER BY RANDOM() LIMIT 20`).all(params);
    const result = { tracks: rows, source: "local_discovery", description: "New from your library" };
    setCached("discover", result, 24 * 3600_000);
    return c.json(result);
  }

  try {
    const discoverArtists = await getSimilarArtistsFromLastfm(topArtistNames.slice(0, 5));
    const newArtists = discoverArtists.filter((a) =>
      !topArtistNames.some((ta) => ta.toLowerCase() === a.toLowerCase())
    );

    const tracks: unknown[] = [];
    for (const artist of newArtists.slice(0, 10)) {
      const rows = db.prepare(
        "SELECT * FROM tracks WHERE lower(artist) LIKE lower($a) ORDER BY RANDOM() LIMIT 2"
      ).all({ $a: `%${artist}%` }) as unknown[];
      tracks.push(...rows);
      if (tracks.length >= 20) break;
    }

    const result = {
      tracks: tracks.slice(0, 20),
      source: "lastfm_discovery",
      description: "Based on what you love",
      similarArtists: newArtists.slice(0, 5),
    };
    setCached("discover", result, 24 * 3600_000);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message, tracks: [] }, 500);
  }
});

/**
 * GET /api/recommendations/mood?mood=X&limit=N
 */
recommendationsRouter.get("/mood", (c) => {
  const mood = c.req.query("mood") ?? "";
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);
  if (!mood) return c.json({ error: "mood parameter required" }, 400);

  const tracks = getTracksByMood(mood, limit);
  return c.json({ tracks, mood, count: tracks.length });
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
  const profile = buildWeightedProfile();
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
  const body = await c.req.json<{ trackId: string; action?: string }>();
  if (!body.trackId) return c.json({ error: "trackId required" }, 400);

  const db = getDb();
  const action = body.action ?? "play";

  db.prepare("INSERT INTO listening_history (track_id, action) VALUES ($id, $a)")
    .run({ $id: body.trackId, $a: action });

  try {
    db.prepare(`
      UPDATE tracks SET play_count = play_count + 1, last_played_at = unixepoch(), updated_at = unixepoch()
      WHERE id = $id
    `).run({ $id: body.trackId });
  } catch { /* column may not exist yet */ }

  // Invalidate caches
  clearCached("home");
  clearCached("taste-profile");
  clearCached("daily-mix");

  return c.json({ ok: true });
});
