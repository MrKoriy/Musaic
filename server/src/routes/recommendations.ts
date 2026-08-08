/** Recommendation HTTP handlers. Domain logic lives under reco/. */

import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { getYandexProvider } from "../providers/yandex.js";
import { canonicalizeTag } from "../reco/tags.js";
import {
  buildWeightedProfile,
  getCached,
  getTracksByMood,
  setCached,
  userCacheKey,
} from "../reco/profile.js";
import {
  buildStationTracks,
  getLastfmKey,
  getSimilarTracksFromLastfm,
  normalizePhrase,
  normalizeTrackRow,
  parseStationSession,
  profileSeeds,
  querySimilarTrackMatches,
  sanitizeSeed,
  selectDiverseTracks,
  type VibeFilters,
} from "../reco/engine.js";
import {
  DAILY_MIX_ALGORITHM_VERSION,
  dailyMixDateContext,
  dailyMixName,
  dailyMixPayload,
  getRecommendationQuality,
  loadDailyMixSnapshot,
  recommendationEnvelope,
  saveDailyMixSnapshot,
} from "../reco/persistence.js";
import { generateRecommendationChat, type RecommendationChatBody } from "../reco/chat.js";
import { recordScrobble, type ScrobbleBody } from "../reco/scrobble.js";

function requestUserId(c: unknown): string | null {
  return ((c as any).get("userId") as string | undefined) ?? null;
}

function bodySeeds(body: Record<string, unknown>) {
  return (Array.isArray(body.seeds) ? body.seeds : [])
    .flatMap((value) => {
      const seed = sanitizeSeed(value);
      return seed ? [seed] : [];
    })
    .slice(0, 20);
}

function bodyExcludeIds(body: Record<string, unknown>): string[] {
  return Array.isArray(body.excludeIds)
    ? body.excludeIds.filter((value): value is string => typeof value === "string").slice(0, 500)
    : [];
}

export const recommendationsRouter = new Hono();

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

recommendationsRouter.get("/home", async (c) => {
  const userId = requestUserId(c);
  const cacheKey = userCacheKey("home", userId);
  const cached = getCached<Record<string, unknown>>(cacheKey);
  if (cached) return c.json(recommendationEnvelope(cached, "home", userId));
  const profile = buildWeightedProfile(userId);
  const db = getDb();

  if (profile.playCount === 0) {
    const yandexProvider = getYandexProvider();
    if (yandexProvider.isAuthenticated()) await yandexProvider.getStationTracks("user:onyourwave", 60).catch(() => []);
    const rows = (db.prepare(`
      SELECT * FROM tracks WHERE source <> 'vk' ORDER BY play_count DESC, updated_at DESC LIMIT 120
    `).all() as Record<string, unknown>[]).map(normalizeTrackRow);
    const result = { tracks: selectDiverseTracks(rows, 20, { mode: "my_vibe", seedArtists: [], filters: { character: "popular" } }), source: "cold_start_popular" };
    setCached(cacheKey, result, 5 * 60_000);
    return c.json(recommendationEnvelope(result, "home", userId));
  }

  const station = await buildStationTracks({ mode: "my_vibe", seeds: profileSeeds(profile), limit: 20, filters: { character: "favorite" }, userId });
  const result = {
    tracks: station.tracks,
    profile: { topArtists: profile.topArtists.slice(0, 5).map((artist) => artist.artist), playCount: profile.playCount },
    source: "personalized_ranker",
  };
  setCached(cacheKey, result, 10 * 60_000);
  return c.json(recommendationEnvelope(result, "home", userId));
});

recommendationsRouter.get("/daily-mix", async (c) => {
  const userId = requestUserId(c);
  const userKey = userId ?? "anonymous";
  const refresh = c.req.query("refresh") === "1";
  const dateContext = dailyMixDateContext(c.req.query("timezone"), c.req.query("localDate"));
  if (!refresh) {
    const existing = loadDailyMixSnapshot(userKey, dateContext.dateKey);
    if (existing) return c.json(recommendationEnvelope(dailyMixPayload(existing), "daily_mix", userId, existing.request_id));
  }
  const profile = buildWeightedProfile(userId);
  const station = await buildStationTracks({
    mode: "my_vibe", seeds: profileSeeds(profile, 8), limit: 20, filters: { character: "favorite" }, userId,
    deterministicSeed: `${userKey}:${dateContext.dateKey}:${DAILY_MIX_ALGORITHM_VERSION}`,
  });
  const snapshot = saveDailyMixSnapshot({ userId, userKey, dateKey: dateContext.dateKey, name: dailyMixName(dateContext.hour), tracks: station.tracks });
  return c.json(recommendationEnvelope(dailyMixPayload(snapshot), "daily_mix", userId, snapshot.request_id));
});

recommendationsRouter.post("/my-vibe", async (c) => {
  const userId = requestUserId(c);
  const body = await c.req.json<Record<string, unknown>>();
  const session = parseStationSession(body);
  const result = await buildStationTracks({
    mode: "my_vibe", seeds: bodySeeds(body), excludeIds: bodyExcludeIds(body),
    limit: typeof body.limit === "number" ? body.limit : undefined,
    filters: body.filters && typeof body.filters === "object" ? body.filters as VibeFilters : undefined,
    userId, session,
  });
  return c.json(recommendationEnvelope({ tracks: result.tracks, source: "my_vibe", seedCount: result.seedCount, filters: result.filters, sessionId: session.sessionId }, "my_vibe", userId));
});

recommendationsRouter.post("/auto-mix", async (c) => {
  const userId = requestUserId(c);
  const body = await c.req.json<Record<string, unknown>>();
  const session = parseStationSession(body);
  const result = await buildStationTracks({ mode: "auto_mix", seeds: bodySeeds(body), excludeIds: bodyExcludeIds(body), limit: typeof body.limit === "number" ? body.limit : 20, userId, session });
  return c.json(recommendationEnvelope({ tracks: result.tracks, source: "auto_mix", seedCount: result.seedCount, sessionId: session.sessionId }, "auto_mix", userId));
});

recommendationsRouter.get("/discover", async (c) => {
  const userId = requestUserId(c);
  const cacheKey = userCacheKey("discover", userId);
  const cached = getCached<Record<string, unknown>>(cacheKey);
  if (cached) return c.json(recommendationEnvelope(cached, "discover", userId));
  const profile = buildWeightedProfile(userId);
  const station = await buildStationTracks({ mode: "my_vibe", seeds: profileSeeds(profile, 10), limit: 20, filters: { character: "unfamiliar" }, userId });
  const result = { tracks: station.tracks, source: "personalized_discovery", description: "New tracks connected to your taste" };
  setCached(cacheKey, result, 24 * 3600_000);
  return c.json(recommendationEnvelope(result, "discover", userId));
});

recommendationsRouter.get("/mood", async (c) => {
  const mood = c.req.query("mood") ?? "";
  const requestedLimit = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.floor(requestedLimit), 50)) : 20;
  if (!mood) return c.json({ error: "mood parameter required" }, 400);
  const userId = requestUserId(c);
  const profile = buildWeightedProfile(userId);
  const station = await buildStationTracks({ mode: "my_vibe", seeds: profileSeeds(profile), limit, filters: { character: "favorite", mood }, userId });
  const tracks = station.tracks.length > 0 ? station.tracks.slice(0, limit) : getTracksByMood(mood, limit, userId);
  return c.json(recommendationEnvelope({ tracks, mood, count: tracks.length }, "mood", userId));
});

recommendationsRouter.get("/station", async (c) => {
  const type = c.req.query("type")?.trim().toLowerCase();
  const key = c.req.query("key")?.trim();
  const requestedLimit = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(requestedLimit) ? Math.max(8, Math.min(Math.floor(requestedLimit), 60)) : 20;
  if (!key || (type !== "artist" && type !== "genre")) return c.json({ error: "type must be artist or genre, and key is required" }, 400);
  const db = getDb();
  const seedRows = type === "artist"
    ? db.prepare("SELECT * FROM tracks WHERE lower(artist) LIKE lower($key) ORDER BY play_count DESC, updated_at DESC LIMIT 20").all({ $key: `%${key}%` }) as Record<string, unknown>[]
    : db.prepare(`
        SELECT DISTINCT t.* FROM tracks t LEFT JOIN track_tags tt ON tt.track_id = t.id
        WHERE lower(COALESCE(t.genre, '')) LIKE lower($key) OR lower(COALESCE(t.mood, '')) LIKE lower($key) OR lower(tt.tag) = lower($key)
        ORDER BY t.play_count DESC, t.updated_at DESC LIMIT 20
      `).all({ $key: canonicalizeTag(key) ?? normalizePhrase(key) }) as Record<string, unknown>[];
  const seeds = seedRows.map((row) => ({ id: String(row.id ?? ""), artist: String(row.artist ?? ""), title: String(row.title ?? ""), album: typeof row.album === "string" ? row.album : undefined })).filter((seed) => seed.id && seed.artist && seed.title);
  const userId = requestUserId(c);
  const result = await buildStationTracks({ mode: "my_vibe", seeds, limit, filters: { character: "favorite" }, userId });
  return c.json(recommendationEnvelope({ tracks: result.tracks, source: "themed_station", stationType: type, stationKey: key, count: result.tracks.length }, "themed_station", userId));
});

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
    const matched: Array<Record<string, unknown>> = [];
    const matchedIDs = new Set<string>();
    for (const signal of similar.slice(0, 20)) {
      for (const row of querySimilarTrackMatches(getDb(), signal)) {
        if (matchedIDs.has(row.id)) continue;
        matchedIDs.add(row.id);
        matched.push({ ...row, _reason: `Similar to ${artist} - ${track}` });
        if (matched.length >= 10) break;
      }
      if (matched.length >= 10) break;
    }
    const result = { tracks: matched, similar: similar.slice(0, 5).map((s) => ({ artist: s.artist, track: s.title })) };
    setCached(cacheKey, result, 30 * 60_000);
    return c.json(result);
  } catch (error) {
    return c.json({ error: (error as Error).message, tracks: [] }, 500);
  }
});

recommendationsRouter.get("/quality", (c) => c.json(getRecommendationQuality({
  userId: requestUserId(c), days: c.req.query("days"), variant: c.req.query("variant"),
})));

recommendationsRouter.post("/chat", async (c) => {
  const body = await c.req.json<RecommendationChatBody>();
  const result = await generateRecommendationChat(body, requestUserId(c));
  return c.json(result.body, result.status);
});

recommendationsRouter.post("/scrobble", async (c) => {
  const body = await c.req.json<ScrobbleBody>();
  const result = recordScrobble(body, requestUserId(c));
  return c.json(result.body, result.status);
});
