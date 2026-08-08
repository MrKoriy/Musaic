import { getDb } from "../db/index.js";
import { buildWeightedProfile } from "./profile.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "minimax/minimax-m2.5:free";
const OPENROUTER_TIMEOUT_MS = 15_000;
const OPENROUTER_MAX_TOKENS = 10;

let openrouterTokens = OPENROUTER_MAX_TOKENS;
let openrouterLastRefill = Date.now();

export interface RecommendationChatBody {
  message: string;
  history?: Array<{ role: string; content: string }>;
}

export interface RecommendationChatResult {
  status: 200 | 400 | 429 | 500 | 503;
  body: Record<string, unknown>;
}

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

function releaseOpenRouterToken(): void {
  openrouterTokens = Math.min(openrouterTokens + 1, OPENROUTER_MAX_TOKENS);
}

export async function generateRecommendationChat(
  body: RecommendationChatBody,
  userId: string | null
): Promise<RecommendationChatResult> {
  if (!body.message) return { status: 400, body: { error: "message required" } };

  const key = process.env.OPENROUTER_API_KEY ?? null;
  if (!key) {
    return { status: 503, body: { error: "OPENROUTER_API_KEY not configured. Add it to server/.env" } };
  }

  if (!consumeOpenRouterToken()) {
    return { status: 429, body: { error: "AI rate limit reached. Try again in a minute." } };
  }

  const db = getDb();
  const profile = buildWeightedProfile(userId);
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
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
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
    if (!response.ok) {
      releaseOpenRouterToken();
      return {
        status: 500,
        body: { error: `AI service error: ${response.status}`, fallback: "Please try again shortly." },
      };
    }

    const data = await response.json() as { choices?: Array<{ message: { content: string } }> };
    return { status: 200, body: { reply: data.choices?.[0]?.message?.content ?? "Sorry, I couldn't generate a response." } };
  } catch (error: unknown) {
    releaseOpenRouterToken();
    return { status: 500, body: { error: (error as Error).message, fallback: "AI is temporarily unavailable." } };
  }
}
