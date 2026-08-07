import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";
import { getDb } from "../db/index.js";
import { recommendationsRouter } from "../routes/recommendations.js";
import { runSimilarItemsJob } from "../jobs/similar-items.js";
import { trainRanker } from "../reco/ranker.js";

function appForUser(userId = "reco-user") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("userId", userId);
    await next();
  });
  app.route("/api/recommendations", recommendationsRouter);
  return app;
}

describe("recommendation enhancements", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("uses persisted tags as a station candidate signal", async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('reco-user', 'reco', 'x')").run();
    seedTrack({ id: "tag-seed", title: "Seed", artist: "Seed Artist", source: "local" });
    seedTrack({ id: "tag-match", title: "Tagged Discovery", artist: "Other Artist", source: "local" });
    for (let index = 0; index < 12; index++) {
      seedTrack({ id: `tag-noise-${index}`, title: `Noise ${index}`, artist: `Noise ${index}`, source: "local" });
    }
    db.prepare("INSERT INTO track_tags (track_id, tag, weight, source) VALUES ('tag-seed', 'ambient', 1, 'test')").run();
    db.prepare("INSERT INTO track_tags (track_id, tag, weight, source) VALUES ('tag-match', 'ambient', 1, 'test')").run();
    const response = await appForUser().request("/api/recommendations/my-vibe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabledSources: ["local"],
        seeds: [{ id: "tag-seed", artist: "Seed Artist", title: "Seed" }],
        limit: 8,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { tracks: Array<{ id: string }> };
    expect(body.tracks.map((track) => track.id)).toContain("tag-match");
  });

  it("reports position metrics and accepts a variant filter", async () => {
    const response = await appForUser().request("/api/recommendations/quality?days=7&variant=A");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      variant: string;
      skipRateByPosition: unknown[];
      sessionLength: { averageEvents: number };
    };
    expect(body.variant).toBe("A");
    expect(body.skipRateByPosition).toEqual([]);
    expect(body.sessionLength.averageEvents).toBe(0);
  });

  it("persists symmetric co-listening similarities", async () => {
    const db = getDb();
    const a = seedTrack({ id: "cf-a", title: "A", artist: "Artist A", source: "local" });
    const b = seedTrack({ id: "cf-b", title: "B", artist: "Artist B", source: "local" });
    const insert = db.prepare(`
      INSERT INTO listening_history (track_id, action, played_at, played_ratio, session_id)
      VALUES ($trackId, 'complete', $playedAt, 1, $sessionId)
    `);
    for (let index = 0; index < 3; index++) {
      insert.run({ $trackId: a, $playedAt: Math.floor(Date.now() / 1000) - index * 100, $sessionId: `cf-${index}` });
      insert.run({ $trackId: b, $playedAt: Math.floor(Date.now() / 1000) - index * 100 + 10, $sessionId: `cf-${index}` });
    }
    const lastfmKey = process.env.LASTFM_API_KEY;
    delete process.env.LASTFM_API_KEY;
    const result = await runSimilarItemsJob();
    if (lastfmKey) process.env.LASTFM_API_KEY = lastfmKey;
    expect(result.coListenPairs).toBeGreaterThan(0);
    const rows = db.prepare("SELECT track_id, other_id FROM similar_items WHERE source = 'co_listen'").all() as Array<{ track_id: string; other_id: string }>;
    expect(rows).toEqual(expect.arrayContaining([
      { track_id: a, other_id: b },
      { track_id: b, other_id: a },
    ]));
  });

  it("trains a ranker from persisted feature vectors", () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('reco-user', 'reco', 'x')").run();
    const accepted = seedTrack({ id: "rank-accepted", title: "Accepted", artist: "A", source: "local" });
    const rejected = seedTrack({ id: "rank-rejected", title: "Rejected", artist: "B", source: "local" });
    for (let index = 0; index < 40; index++) {
      const isAccepted = index % 2 === 0;
      const requestId = `rank-request-${index}`;
      const trackId = isAccepted ? accepted : rejected;
      const features = Array.from({ length: 15 }, (_, feature) => feature === 0 ? (isAccepted ? 2 : -2) : (isAccepted ? 1 : 0));
      db.prepare(`
        INSERT INTO recommendation_impressions
          (request_id, user_id, surface, track_id, position, features_json)
        VALUES ($requestId, 'reco-user', 'my_vibe', $trackId, 0, $features)
      `).run({ $requestId: requestId, $trackId: trackId, $features: JSON.stringify(features) });
      db.prepare(`
        INSERT INTO listening_history
          (track_id, action, played_ratio, request_id, surface)
        VALUES ($trackId, $action, $ratio, $requestId, 'my_vibe')
      `).run({ $trackId: trackId, $action: isAccepted ? "complete" : "skip", $ratio: isAccepted ? 1 : 0.02, $requestId: requestId });
    }
    const model = trainRanker();
    expect(model).not.toBeNull();
    expect(model?.impressionsUsed).toBe(40);
    expect((db.prepare("SELECT COUNT(*) AS n FROM reco_models").get() as { n: number }).n).toBe(1);
  });
});
