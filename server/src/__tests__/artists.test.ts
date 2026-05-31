import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import searchRoutes from "../routes/search.js";
import { artistsRouter } from "../routes/local.js";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";

function buildApp() {
  const app = new Hono();
  app.route("/api/search", searchRoutes);
  app.route("/api/artists", artistsRouter);
  return app;
}

describe("Artist search/profile API", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("returns local artists as a separate search section", async () => {
    seedTrack({ title: "Hysteria", artist: "Muse", album: "Absolution" });
    seedTrack({ title: "Time Is Running Out", artist: "Muse", album: "Absolution" });

    const res = await buildApp().request("/api/search?q=Muse&sources=local");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      artists?: Array<{ artist: string; source: string; track_count: number; album_count: number }>;
      tracks: unknown[];
    };

    expect(body.artists?.[0]).toMatchObject({
      artist: "Muse",
      source: "local",
      track_count: 2,
      album_count: 1,
    });
  });

  it("builds a local artist profile with tracks and albums", async () => {
    seedTrack({ title: "Hysteria", artist: "Muse", album: "Absolution" });
    seedTrack({ title: "Stockholm Syndrome", artist: "Muse", album: "Absolution" });
    seedTrack({ title: "Paranoid Android", artist: "Radiohead", album: "OK Computer" });

    const res = await buildApp().request("/api/artists/profile?artist=Muse&sources=local");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      artist: { artist: string; track_count: number; album_count: number };
      tracks: Array<{ artist: string; source: string }>;
      albums: Array<{ album: string; artist: string; source: string; track_count: number }>;
      available_sources: string[];
    };

    expect(body.artist).toMatchObject({ artist: "Muse", track_count: 2, album_count: 1 });
    expect(body.available_sources).toEqual(["local"]);
    expect(body.tracks).toHaveLength(2);
    expect(body.tracks.every((track) => track.artist === "Muse" && track.source === "local")).toBe(true);
    expect(body.albums).toEqual([{ album: "Absolution", artist: "Muse", track_count: 2, source: "local" }]);
  });

  it("keeps cached source variants in artist profiles for accurate filtering", async () => {
    seedTrack({ id: "local-hysteria", source: "local", title: "Hysteria", artist: "Muse", album: "Absolution" });
    seedTrack({ id: "vk-hysteria", source: "vk", title: "Hysteria", artist: "Muse", album: "Absolution" });

    const res = await buildApp().request("/api/artists/profile?artist=Muse&sources=local,vk");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      tracks: Array<{ title: string; source: string }>;
      albums: Array<{ album: string; source: string; track_count: number }>;
      available_sources: string[];
    };

    expect(body.available_sources).toEqual(["local", "vk"]);
    expect(body.tracks.map((track) => track.source).sort()).toEqual(["local", "vk"]);
    expect(body.albums).toHaveLength(1);
    expect(body.albums[0]).toMatchObject({ album: "Absolution", source: "mixed", track_count: 1 });
  });
});
