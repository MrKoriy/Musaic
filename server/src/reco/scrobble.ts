import { logListening } from "../db/index.js";
import { clearUserRecommendationCaches } from "./profile.js";

export interface ScrobbleBody {
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
}

export type ScrobbleResult =
  | { status: 200; body: { ok: true; inserted: boolean } }
  | { status: 400; body: { error: string } };

export function recordScrobble(body: ScrobbleBody, userId: string | null): ScrobbleResult {
  if (!body.trackId) return { status: 400, body: { error: "trackId required" } };

  const action = body.action ?? "play";
  const validActions = new Set(["play", "pause", "skip", "like", "unlike", "dislike", "complete"]);
  if (!validActions.has(action)) return { status: 400, body: { error: "Invalid action" } };

  const inserted = logListening(body.trackId, action, userId, body);
  clearUserRecommendationCaches(userId);
  return { status: 200, body: { ok: true, inserted } };
}
