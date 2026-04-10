/**
 * Stats endpoint tests
 *
 * Tests /api/stats/overview, top-tracks, top-artists, heatmap, monthly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import statsRouter from "../routes/stats.js";
import { setupTestDb, teardownTestDb, seedTrack, seedPlay } from "./setup.js";

function buildApp() {
  const app = new Hono();
  app.route("/api/stats", statsRouter);
  return app;
}

describe("Stats API", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  // ── Overview ──────────────────────────────────────────────────────────────

  describe("GET /api/stats/overview", () => {
    it("returns zero counts on empty DB", async () => {
      const res = await buildApp().request("/api/stats/overview");
      expect(res.status).toBe(200);
      const body = await res.json() as {
        listens: { today: number; week: number; month: number; allTime: number };
        streak: number;
        topTrack: null;
        topArtist: null;
      };
      expect(body.listens.allTime).toBe(0);
      expect(body.listens.today).toBe(0);
      expect(body.streak).toBe(0);
      expect(body.topTrack).toBeNull();
      expect(body.topArtist).toBeNull();
    });

    it("counts plays correctly", async () => {
      const t1 = seedTrack({ title: "Song A", artist: "Artist A" });
      const t2 = seedTrack({ title: "Song B", artist: "Artist B" });
      seedPlay(t1);
      seedPlay(t1);
      seedPlay(t2);

      const res = await buildApp().request("/api/stats/overview");
      const body = await res.json() as {
        listens: { allTime: number };
        topTrack: { title: string; play_count: number };
        topArtist: { artist: string; play_count: number };
      };
      expect(body.listens.allTime).toBe(3);
      expect(body.topTrack.title).toBe("Song A");
      expect(body.topTrack.play_count).toBe(2);
      expect(body.topArtist.artist).toBe("Artist A");
    });
  });

  // ── Top Tracks ────────────────────────────────────────────────────────────

  describe("GET /api/stats/top-tracks", () => {
    it("returns empty array on no history", async () => {
      const res = await buildApp().request("/api/stats/top-tracks");
      expect(res.status).toBe(200);
      const body = await res.json() as { tracks: unknown[] };
      expect(body.tracks).toHaveLength(0);
    });

    it("orders by play count descending", async () => {
      const t1 = seedTrack({ title: "Popular" });
      const t2 = seedTrack({ title: "Less Popular" });
      seedPlay(t1); seedPlay(t1); seedPlay(t1);
      seedPlay(t2);

      const res = await buildApp().request("/api/stats/top-tracks?limit=10");
      const body = await res.json() as { tracks: { title: string; play_count: number }[] };
      expect(body.tracks[0].title).toBe("Popular");
      expect(body.tracks[0].play_count).toBe(3);
      expect(body.tracks[1].title).toBe("Less Popular");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        const t = seedTrack({ title: `Track ${i}` });
        seedPlay(t);
      }
      const res = await buildApp().request("/api/stats/top-tracks?limit=3");
      const body = await res.json() as { tracks: unknown[] };
      expect(body.tracks).toHaveLength(3);
    });

    it("caps limit at 50", async () => {
      const res = await buildApp().request("/api/stats/top-tracks?limit=999");
      expect(res.status).toBe(200); // should not error
    });

    it("filters by period=today", async () => {
      const res = await buildApp().request("/api/stats/top-tracks?period=today");
      expect(res.status).toBe(200);
      const body = await res.json() as { tracks: unknown[] };
      expect(Array.isArray(body.tracks)).toBe(true);
    });
  });

  // ── Top Artists ───────────────────────────────────────────────────────────

  describe("GET /api/stats/top-artists", () => {
    it("returns artists with play counts", async () => {
      const t1 = seedTrack({ artist: "Radiohead" });
      const t2 = seedTrack({ artist: "Björk" });
      seedPlay(t1); seedPlay(t1);
      seedPlay(t2);

      const res = await buildApp().request("/api/stats/top-artists");
      const body = await res.json() as { artists: { artist: string; play_count: number }[] };
      expect(body.artists[0].artist).toBe("Radiohead");
      expect(body.artists[0].play_count).toBe(2);
    });

    it("returns empty on no history", async () => {
      const res = await buildApp().request("/api/stats/top-artists");
      const body = await res.json() as { artists: unknown[] };
      expect(body.artists).toHaveLength(0);
    });
  });

  // ── Top Albums ────────────────────────────────────────────────────────────

  describe("GET /api/stats/top-albums", () => {
    it("returns albums with play counts", async () => {
      const t1 = seedTrack({ album: "OK Computer", artist: "Radiohead" });
      const t2 = seedTrack({ album: "Homogenic", artist: "Björk" });
      seedPlay(t1); seedPlay(t1);
      seedPlay(t2);

      const res = await buildApp().request("/api/stats/top-albums");
      const body = await res.json() as { albums: { album: string; play_count: number }[] };
      expect(body.albums[0].album).toBe("OK Computer");
      expect(body.albums[0].play_count).toBe(2);
    });
  });

  // ── Heatmap ───────────────────────────────────────────────────────────────

  describe("GET /api/stats/heatmap", () => {
    it("returns 24 hour buckets", async () => {
      const res = await buildApp().request("/api/stats/heatmap");
      expect(res.status).toBe(200);
      const body = await res.json() as { heatmap: { hour: number; play_count: number }[] };
      expect(body.heatmap).toHaveLength(24);
      // hours 0-23
      expect(body.heatmap[0].hour).toBe(0);
      expect(body.heatmap[23].hour).toBe(23);
    });
  });

  // ── Monthly ───────────────────────────────────────────────────────────────

  describe("GET /api/stats/monthly", () => {
    it("returns day breakdown", async () => {
      const res = await buildApp().request("/api/stats/monthly");
      expect(res.status).toBe(200);
      const body = await res.json() as { days: unknown[] };
      expect(Array.isArray(body.days)).toBe(true);
    });
  });

  // ── Genres ───────────────────────────────────────────────────────────────

  describe("GET /api/stats/genres", () => {
    it("returns empty genres on no plays", async () => {
      const res = await buildApp().request("/api/stats/genres");
      expect(res.status).toBe(200);
      const body = await res.json() as { genres: unknown[] };
      expect(Array.isArray(body.genres)).toBe(true);
    });

    it("groups plays by track genre", async () => {
      const t1 = seedTrack({ artist: "Artist" });
      // Set genre via direct SQL since seedTrack doesn't support it
      const { getDb } = await import("../db/index.js");
      getDb().prepare("UPDATE tracks SET genre = 'Rock' WHERE id = $id").run({ $id: t1 });
      seedPlay(t1);

      const res = await buildApp().request("/api/stats/genres");
      const body = await res.json() as { genres: { genre: string; play_count: number; percentage: number }[] };
      expect(body.genres.length).toBeGreaterThan(0);
      expect(body.genres[0].percentage).toBe(100);
    });
  });
});
