import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { recommendationsRouter } from "../routes/recommendations.js";
import { getDb } from "../db/index.js";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";
import { baseTrackTitle } from "../utils/track-identity.js";
import { clearUserRecommendationCaches } from "../providers/taste-engine.js";

function appForUser(userId: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("userId", userId);
    await next();
  });
  app.route("/api/recommendations", recommendationsRouter);
  return app;
}

describe("recommendation ranking", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("applies a dislike to the same song cached under another source id", async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('user-a', 'alice', 'x')").run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS yandex_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        token TEXT,
        username TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    const dislikedId = seedTrack({
      id: "local-disliked",
      title: "Duplicate Song",
      artist: "Seed Artist",
      source: "local",
    });
    seedTrack({
      id: "sc-duplicate",
      title: "Duplicate Song",
      artist: "Seed Artist",
      source: "soundcloud",
    });
    for (let index = 0; index < 6; index++) {
      seedTrack({
        id: `seed-${index}`,
        title: `Candidate ${index}`,
        artist: "Seed Artist",
        source: "local",
      });
    }
    db.prepare(`
      INSERT INTO listening_history (track_id, action, user_id)
      VALUES ($id, 'dislike', 'user-a')
    `).run({ $id: dislikedId });

    const response = await appForUser("user-a").request("/api/recommendations/my-vibe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seeds: [{ id: "seed-0", artist: "Seed Artist", title: "Candidate 0" }],
        limit: 12,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      requestId?: string;
      tracks: Array<{ id: string; title: string }>;
    };

    expect(body.requestId).toBeString();
    const requestId = body.requestId;
    if (!requestId) throw new Error("recommendation request id is missing");
    expect(body.tracks.map((track) => track.id)).not.toContain("local-disliked");
    expect(body.tracks.map((track) => track.id)).not.toContain("sc-duplicate");
    const impressions = db.prepare(`
      SELECT COUNT(*) AS n FROM recommendation_impressions WHERE request_id = $requestId
    `).get({ $requestId: requestId }) as { n: number };
    expect(impressions.n).toBe(body.tracks.length);
  });

  it("keeps only the best version of a song in a recommendation queue", async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('user-a', 'alice', 'x')").run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS yandex_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        token TEXT,
        username TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    const originalId = seedTrack({ id: "anthem-original", title: "Variant Anthem", artist: "Same Artist", source: "local" });
    const variants = [
      "Variant Anthem (Slowed + Reverb)",
      "Variant Anthem - Club Remix",
      "Variant Anthem Sped Up",
      "Variant Anthem [Live Version]",
      "Variant Anthem (2024 Remaster)",
      "Variant Anthem — Extended Mix",
    ];
    variants.forEach((title, index) => {
      seedTrack({
        id: `anthem-${index}`,
        title,
        artist: index % 2 === 0 ? "Same Artist feat. Guest" : "Remix Producer",
        source: "soundcloud",
      });
    });
    for (let index = 0; index < 4; index++) {
      seedTrack({ id: `same-artist-${index}`, title: `Side Track ${index}`, artist: "Same Artist", source: "local" });
    }
    for (let index = 0; index < 12; index++) {
      seedTrack({ id: `other-${index}`, title: `Other Song ${index}`, artist: `Other Artist ${index}`, source: "local" });
    }
    db.prepare("INSERT INTO listening_history (track_id, action, user_id) VALUES ($id, 'complete', 'user-a')")
      .run({ $id: originalId });

    const response = await appForUser("user-a").request("/api/recommendations/my-vibe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seeds: [{ id: originalId, artist: "Same Artist", title: "Variant Anthem" }],
        limit: 12,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      tracks: Array<{ id: string; artist: string; title: string }>;
    };
    const baseTitle = baseTrackTitle("Variant Anthem");
    const familyTracks = body.tracks.filter((track) => baseTrackTitle(track.title) === baseTitle);

    expect(familyTracks).toHaveLength(1);
  });

  it("learns which tracks naturally follow a seed inside listening sessions", async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('user-a', 'alice', 'x')").run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS yandex_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        token TEXT,
        username TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    const anchor = seedTrack({ id: "session-anchor", title: "Anchor", artist: "Anchor Artist", source: "local" });
    const naturalNext = seedTrack({ id: "natural-next", title: "Natural Next", artist: "Flow Artist", source: "local" });
    for (let index = 0; index < 6; index++) {
      seedTrack({ id: `anchor-catalog-${index}`, title: `Anchor Catalog ${index}`, artist: "Anchor Artist", source: "local" });
    }
    for (let index = 0; index < 30; index++) {
      seedTrack({ id: `noise-${index}`, title: `Noise ${index}`, artist: `Noise Artist ${index}`, source: "local" });
    }

    const insert = db.prepare(`
      INSERT INTO listening_history
        (track_id, action, played_at, user_id, played_ratio, session_id)
      VALUES ($trackId, 'complete', $playedAt, 'user-a', 1, $sessionId)
    `);
    const now = Math.floor(Date.now() / 1000);
    for (let index = 0; index < 4; index++) {
      const sessionId = `session-${index}`;
      insert.run({ $trackId: anchor, $playedAt: now - 4000 + index * 100, $sessionId: sessionId });
      insert.run({ $trackId: naturalNext, $playedAt: now - 3990 + index * 100, $sessionId: sessionId });
    }

    const response = await appForUser("user-a").request("/api/recommendations/my-vibe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seeds: [{ id: anchor, artist: "Anchor Artist", title: "Anchor" }],
        limit: 8,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { tracks: Array<{ id: string }> };

    expect(body.tracks[0]?.id).toBe(naturalNext);
  });

  it("suppresses an artist after repeated early skips and dislikes", async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('user-a', 'alice', 'x')").run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS yandex_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        token TEXT,
        username TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    const anchor = seedTrack({
      id: "aversion-anchor",
      title: "Anchor Song",
      artist: "Anchor Artist",
      album: "Shared Signal Album",
      source: "local",
    });
    for (let index = 0; index < 6; index++) {
      seedTrack({ id: `aversion-anchor-${index}`, title: `Anchor ${index}`, artist: "Anchor Artist", source: "local" });
    }
    const rejectedA = seedTrack({ id: "rejected-a", title: "Rejected A", artist: "Rejected Artist", album: "Shared Signal Album" });
    const rejectedB = seedTrack({ id: "rejected-b", title: "Rejected B", artist: "Rejected Artist", album: "Shared Signal Album" });
    seedTrack({ id: "rejected-new", title: "Rejected New", artist: "Rejected Artist", album: "Shared Signal Album" });
    for (let index = 0; index < 12; index++) {
      seedTrack({
        id: `accepted-alternative-${index}`,
        title: `Alternative ${index}`,
        artist: `Alternative Artist ${index}`,
        album: "Shared Signal Album",
      });
    }

    const insert = db.prepare(`
      INSERT INTO listening_history (track_id, action, user_id, played_ratio)
      VALUES ($trackId, $action, 'user-a', $ratio)
    `);
    for (const trackId of [rejectedA, rejectedB]) {
      insert.run({ $trackId: trackId, $action: "skip", $ratio: 0.04 });
      insert.run({ $trackId: trackId, $action: "dislike", $ratio: null });
    }

    const response = await appForUser("user-a").request("/api/recommendations/my-vibe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seeds: [{ id: anchor, artist: "Anchor Artist", title: "Anchor Song", album: "Shared Signal Album" }],
        limit: 8,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { tracks: Array<{ artist: string }> };

    expect(body.tracks.map((track) => track.artist)).not.toContain("Rejected Artist");
  });

  it("persists one stable Daily Mix delivery until explicit refresh", async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('daily-user', 'daily', 'x')").run();
    const seed = seedTrack({ id: "daily-seed", title: "Daily Seed", artist: "Daily Artist" });
    for (let index = 0; index < 30; index++) {
      seedTrack({
        id: `daily-track-${index.toString().padStart(2, "0")}`,
        title: `Daily Track ${index}`,
        artist: index < 12 ? "Daily Artist" : `Related Artist ${index % 6}`,
      });
    }
    db.prepare(`
      INSERT INTO listening_history (track_id, action, user_id, played_ratio)
      VALUES ($trackId, 'complete', 'daily-user', 1)
    `).run({ $trackId: seed });

    const app = appForUser("daily-user");
    const path = "/api/recommendations/daily-mix?timezone=UTC&localDate=2026-01-02";
    const first = await (await app.request(path)).json() as {
      requestId: string; revision: number; tracks: Array<{ id: string }>;
    };
    const firstIds = first.tracks.map((track) => track.id);

    // Simulate ordinary telemetry invalidation and an in-process cache clear.
    db.prepare(`
      INSERT INTO listening_history (track_id, action, user_id, played_ratio)
      VALUES ('daily-track-01', 'skip', 'daily-user', 0.02)
    `).run();
    clearUserRecommendationCaches("daily-user");
    const restored = await (await appForUser("daily-user").request(path)).json() as {
      requestId: string; revision: number; tracks: Array<{ id: string }>;
    };

    expect(restored.requestId).toBe(first.requestId);
    expect(restored.revision).toBe(1);
    expect(restored.tracks.map((track) => track.id)).toEqual(firstIds);
    expect((db.prepare("SELECT COUNT(*) AS n FROM daily_mix_snapshots WHERE user_key = 'daily-user'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM recommendation_impressions WHERE request_id = $id").get({ $id: first.requestId }) as { n: number }).n).toBe(firstIds.length);

    const refreshed = await (await app.request(`${path}&refresh=1`)).json() as {
      requestId: string; revision: number; tracks: Array<{ id: string }>;
    };
    expect(refreshed.requestId).not.toBe(first.requestId);
    expect(refreshed.revision).toBe(2);
  });

  it("isolates Daily Mix snapshots by user and keeps deterministic ordering", async () => {
    const db = getDb();
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES ('mix-a', 'mix-a', 'x');
      INSERT INTO users (id, username, password_hash) VALUES ('mix-b', 'mix-b', 'x');
    `);
    const seedA = seedTrack({ id: "mix-a-seed", title: "A Seed", artist: "Artist A" });
    const seedB = seedTrack({ id: "mix-b-seed", title: "B Seed", artist: "Artist B" });
    for (let index = 0; index < 16; index++) {
      seedTrack({ id: `mix-a-${index}`, title: `A ${index}`, artist: "Artist A" });
      seedTrack({ id: `mix-b-${index}`, title: `B ${index}`, artist: "Artist B" });
    }
    const insert = db.prepare("INSERT INTO listening_history (track_id, action, user_id, played_ratio) VALUES ($id, 'complete', $userId, 1)");
    insert.run({ $id: seedA, $userId: "mix-a" });
    insert.run({ $id: seedB, $userId: "mix-b" });
    const path = "/api/recommendations/daily-mix?timezone=UTC";

    const a = await (await appForUser("mix-a").request(path)).json() as { requestId: string; tracks: Array<{ id: string }> };
    const b = await (await appForUser("mix-b").request(path)).json() as { requestId: string; tracks: Array<{ id: string }> };
    const aAgain = await (await appForUser("mix-a").request(path)).json() as { requestId: string; tracks: Array<{ id: string }> };

    expect(a.requestId).toBe(aAgain.requestId);
    expect(a.tracks.map((track) => track.id)).toEqual(aAgain.tracks.map((track) => track.id));
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.tracks.some((track) => track.id.startsWith("mix-a-"))).toBe(true);
    expect(b.tracks.some((track) => track.id.startsWith("mix-b-"))).toBe(true);
  });

  it("applies bounded session context, source filtering, and refill tail dedupe", async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('session-user', 'session', 'x')").run();
    seedTrack({ id: "tail-local", title: "Same Song", artist: "Tail Artist", source: "local" });
    seedTrack({ id: "tail-soundcloud", title: "Same Song", artist: "Tail Artist", source: "soundcloud" });
    seedTrack({ id: "blocked-soundcloud", title: "Blocked", artist: "Video Artist", source: "soundcloud" });
    for (let index = 0; index < 12; index++) seedTrack({ id: `session-local-${index}`, title: `Local ${index}`, artist: `Artist ${index}`, source: "local" });
    const response = await appForUser("session-user").request("/api/recommendations/my-vibe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "wave-1", seeds: [{ id: "tail-local", artist: "Tail Artist", title: "Same Song" }],
        queueTail: [{ id: "tail-local", artist: "Tail Artist", title: "Same Song" }], enabledSources: ["local", "vk"],
        recentOutcomes: Array.from({ length: 30 }, (_, i) => ({ id: `x-${i}`, artist: "Skipped Artist", title: `X ${i}`, action: "skip", completionRatio: 0.02 })), limit: 8 })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { sessionId?: string; tracks: Array<{ source: string; canonicalFamilyId?: string; id: string }> };
    expect(body.sessionId).toBe("wave-1");
    expect(body.tracks.every((track) => track.source === "local")).toBe(true);
    expect(body.tracks.map((track) => track.id)).not.toContain("tail-soundcloud");
    expect(new Set(body.tracks.map((track) => track.canonicalFamilyId)).size).toBe(body.tracks.length);
  });

});