import { getDb } from "../db/index.js";
import { buildWeightedProfile } from "./profile.js";

const DEFAULT_AI_BASE = "https://api.b.ai/v1";
// Keep the model configurable so provider model renames do not require a
// client release. GLM is the default recommendation assistant model.
const DEFAULT_MODEL = "glm-5.3-flash";
const AI_TIMEOUT_MS = 15_000;
const AI_MAX_TOKENS_PER_MINUTE = 10;

let aiTokens = AI_MAX_TOKENS_PER_MINUTE;
let aiLastRefill = Date.now();

export interface RecommendationChatBody {
  message: string;
  history?: Array<{ role: string; content: string }>;
}

export interface RecommendationChatResult {
  status: 200 | 400 | 429 | 500 | 503;
  body: Record<string, unknown>;
}

function consumeAiToken(): boolean {
  const now = Date.now();
  if (now - aiLastRefill >= 60_000) {
    aiTokens = AI_MAX_TOKENS_PER_MINUTE;
    aiLastRefill = now;
  }
  if (aiTokens <= 0) return false;
  aiTokens--;
  return true;
}

function releaseAiToken(): void {
  aiTokens = Math.min(aiTokens + 1, AI_MAX_TOKENS_PER_MINUTE);
}

// Read env at call time so tests (and config reloads) are not bound to the
// process' startup environment.
function aiConfig(): { base: string; key: string | null; model: string } {
  const key = process.env.AI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null;
  return {
    base: (process.env.AI_BASE_URL ?? DEFAULT_AI_BASE).replace(/\/+$/, ""),
    key: key && key.trim() ? key : null,
    model: process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
  };
}

export async function generateRecommendationChat(
  body: RecommendationChatBody,
  userId: string | null
): Promise<RecommendationChatResult> {
  if (!body.message?.trim()) return { status: 400, body: { error: "message required" } };
  if (body.message.length > 2_000) return { status: 400, body: { error: "message too long" } };

  const history = (body.history ?? [])
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-12)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 2_000) }));

  const { base, key, model } = aiConfig();
  if (!key) {
    return { status: 503, body: { error: "AI_API_KEY not configured. Add it to server/.env" } };
  }

  if (!consumeAiToken()) {
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
    ...history,
    { role: "user", content: body.message.trim() },
  ];

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens: 500, temperature: 0.65 }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!response.ok) {
      releaseAiToken();
      return {
        status: 500,
        body: { error: `AI service error: ${response.status}`, fallback: "Please try again shortly." },
      };
    }

    const data = await response.json() as { choices?: Array<{ message: { content: string } }> };
    return { status: 200, body: { reply: data.choices?.[0]?.message?.content ?? "Sorry, I couldn't generate a response." } };
  } catch (error: unknown) {
    releaseAiToken();
    return { status: 500, body: { error: (error as Error).message, fallback: "AI is temporarily unavailable." } };
  }
}
