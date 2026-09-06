import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { releasesRouter } from "../routes/releases.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

function buildApp() {
  const app = new Hono();
  app.route("/api/releases", releasesRouter);
  return app;
}

interface ReleaseSeed {
  id?: string;
  artist?: string;
  title?: string;
  year?: number | null;
  coverUrl?: string | null;
  trackCount?: number | null;
  firstSeenAt?: number;
  notifiedAt?: number | null;
}

function seedRelease(db: ReturnType<typeof import("../db/index.js").getDb>, overrides: ReleaseSeed = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO artist_releases
      (id, artist, title, year, cover_url, track_count, first_seen_at, notified_at)
    VALUES ($id, $artist, $title, $year, $cover, $trackCount, $firstSeen, $notified)
  `).run({
    $id: overrides.id ?? "yandex_1",
    $artist: overrides.artist ?? "Kai Angel",
    $title: overrides.title ?? "New Album",
    $year: overrides.year ?? 2026,
    $cover: overrides.coverUrl ?? null,
    $trackCount: overrides.trackCount ?? 10,
    $firstSeen: overrides.firstSeenAt ?? 1_000,
    $notified: overrides.notifiedAt ?? null,
  });
}

describe("Releases API", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("GET /api/releases/new — returns only unnotified releases", async () => {
    const { getDb } = await import("../db/index.js");
    const db = getDb();
    seedRelease(db, { id: "yandex_new", title: "Fresh", notifiedAt: null });
    seedRelease(db, { id: "yandex_old", title: "Old", notifiedAt: 5_000 });

    const res = await buildApp().request("/api/releases/new");
    expect(res.status).toBe(200);
    const body = await res.json() as { releases: Array<{ id: string; title: string }> };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0].id).toBe("yandex_new");
  });

  it("POST /api/releases/ack — marks releases as notified", async () => {
    const { getDb } = await import("../db/index.js");
    const db = getDb();
    seedRelease(db, { id: "yandex_a", title: "A", notifiedAt: null });
    seedRelease(db, { id: "yandex_b", title: "B", notifiedAt: null });

    const res = await buildApp().request("/api/releases/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["yandex_a"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { acked: number };
    expect(body.acked).toBe(1);

    const list = await buildApp().request("/api/releases/new");
    const listBody = await list.json() as { releases: Array<{ id: string }> };
    expect(listBody.releases.map((r) => r.id)).toEqual(["yandex_b"]);
  });
});
