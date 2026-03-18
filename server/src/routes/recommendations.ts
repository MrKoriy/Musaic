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

  const newArtists = discoverArtists.filter((a) => !topArtistNames.includes(a));
  const recommendations: unknown[] = [];

  for (const artist of newArtists.slice(0, 8)) {
    const rows = db.prepare(
      "SELECT * FROM tracks WHERE lower(artist) LIKE lower($a) ORDER BY RANDOM() LIMIT 2"
    ).all({ $a: `%${artist}%` }) as unknown[];
    recommendations.push(...rows);
    if (recommendations.length >= 15) break;
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
  const cached = getCached<unknown>("daily-mix");
  if (cached) return c.json(cached);

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
    const data = await lastfmGet({ method: "track.getSimilar", artist, track, limit: "30" }) as {
      similartracks?: { track?: Array<{ name: string; artist: { name: string } }> }
    };
    const similar = data.similartracks?.track ?? [];
    if (similar.length === 0) return c.json({ tracks: [] });

    const db = getDb();
    const matched: unknown[] = [];
    for (const s of similar.slice(0, 20)) {
      const row = db.prepare(
        "SELECT * FROM tracks WHERE lower(artist) LIKE lower($artist) LIMIT 1"
      ).get({ $artist: `%${s.artist.name}%` });
      if (row) {
        matched.push({ ...(row as object), _reason: `Similar to ${artist} - ${track}` });
        if (matched.length >= 10) break;
      }
    }

    const result = { tracks: matched, similar: similar.slice(0, 5).map((s) => ({ artist: s.artist.name, track: s.name })) };
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
  setCached("home", null as any, 0);
  setCached("taste-profile", null as any, 0);
  setCached("daily-mix", null as any, 0);

  return c.json({ ok: true });
});
