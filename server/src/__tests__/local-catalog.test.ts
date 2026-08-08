import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import albumsRouter from "../routes/local/albums.js";
import artistsRouter from "../routes/local/artists.js";
import coversRouter from "../routes/local/covers.js";
import { getDb, setCoverData } from "../db/index.js";
import { seedTrack, setupTestDb, teardownTestDb } from "./setup.js";

type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
) => Response | Promise<Response>;

function installFetchMock(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => handler(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function catalogApp(): Hono {
  const app = new Hono();
  app.route("/api/albums", albumsRouter);
  app.route("/api/artists", artistsRouter);
  app.route("/api/covers", coversRouter);
  return app;
}

describe("local catalog routes", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("groups albums and artists with source and pagination filters", async () => {
    const first = seedTrack({
      id: "catalog-first",
      source: "local",
      title: "First",
      artist: "Alpha",
      album: "Blue",
    });
    seedTrack({
      id: "catalog-second",
      source: "local",
      title: "Second",
      artist: "Alpha",
      album: "Blue",
    });
    seedTrack({
      id: "catalog-other-source",
      source: "yandex",
      title: "Remote",
      artist: "Alpha",
      album: "Blue",
    });
    seedTrack({ id: "catalog-no-album", source: "local", artist: "No Album", album: "" });

    const albums = await catalogApp().request("/api/albums?source=local&limit=10&offset=0");
    expect(albums.status).toBe(200);
    expect(await albums.json()).toEqual({
      albums: [{ album: "Blue", artist: "Alpha", track_count: 2, cover_url: null, source: "local" }],
    });

    const allAlbums = await catalogApp().request("/api/albums?limit=1&offset=1");
    expect(allAlbums.status).toBe(200);
    expect((await allAlbums.json() as { albums: Array<{ album: string; artist: string; track_count: number; cover_url: string | null; source: string }> }).albums).toEqual([
      { album: "Blue", artist: "Alpha", track_count: 1, cover_url: null, source: "yandex" },
    ]);

    const artists = await catalogApp().request("/api/albums/artists?source=local");
    expect(await artists.json()).toEqual({
      artists: [
        { artist: "Alpha", track_count: 2, album_count: 1, cover_url: null },
        { artist: "No Album", track_count: 1, album_count: 1, cover_url: null },
      ],
    });
    const allArtists = await catalogApp().request("/api/albums/artists");
    expect((await allArtists.json() as { artists: Array<{ artist: string }> }).artists.map((row) => row.artist))
      .toEqual(["Alpha", "No Album"]);

    const tracksWithAllFilters = await catalogApp().request("/api/albums/tracks?album=Blue&artist=Alpha&source=local");
    expect((await tracksWithAllFilters.json() as { tracks: Array<{ id: string }> }).tracks.map((track) => track.id))
      .toEqual([first, "catalog-second"]);
    const tracksWithSource = await catalogApp().request("/api/albums/tracks?album=Blue&source=local");
    expect((await tracksWithSource.json() as { tracks: Array<{ id: string }> }).tracks).toHaveLength(2);
    const tracksWithArtist = await catalogApp().request("/api/albums/tracks?album=Blue&artist=Alpha");
    expect((await tracksWithArtist.json() as { tracks: Array<{ id: string }> }).tracks).toHaveLength(3);
    const tracksWithAlbumOnly = await catalogApp().request("/api/albums/tracks?album=Blue");
    expect((await tracksWithAlbumOnly.json() as { tracks: Array<{ id: string }> }).tracks).toHaveLength(3);

    const missingAlbum = await catalogApp().request("/api/albums/tracks");
    expect(missingAlbum.status).toBe(400);
    expect(await missingAlbum.json()).toEqual({ error: "album required" });
  });

  it("serves artist lists, tracks, and a local artist profile", async () => {
    seedTrack({ id: "artist-one", source: "local", title: "One", artist: "North Star", album: "Night", duration: 180 });
    seedTrack({ id: "artist-two", source: "local", title: "Two", artist: "North Star", album: "Dawn", duration: 200 });
    seedTrack({ id: "artist-remote", source: "yandex", title: "Remote", artist: "North Star", album: "Night" });

    const sourceArtists = await catalogApp().request("/api/artists?source=local");
    expect(await sourceArtists.json()).toEqual({
      artists: [{ artist: "North Star", track_count: 2, album_count: 2, cover_url: null }],
    });
    const allArtists = await catalogApp().request("/api/artists");
    expect((await allArtists.json() as { artists: Array<{ track_count: number }> }).artists[0]?.track_count).toBe(3);

    const noArtist = await catalogApp().request("/api/artists/tracks");
    expect(noArtist.status).toBe(400);
    expect(await noArtist.json()).toEqual({ error: "artist required" });
    const tracks = await catalogApp().request("/api/artists/tracks?artist=North%20Star&source=local");
    expect((await tracks.json() as { tracks: Array<{ id: string }> }).tracks.map((track) => track.id))
      .toEqual(["artist-two", "artist-one"]);
    const allTracks = await catalogApp().request("/api/artists/tracks?artist=North%20Star");
    expect((await allTracks.json() as { tracks: Array<{ id: string }> }).tracks).toHaveLength(3);

    const missingProfileArtist = await catalogApp().request("/api/artists/profile");
    expect(missingProfileArtist.status).toBe(400);
    expect(await missingProfileArtist.json()).toEqual({ error: "artist required" });
    const profile = await catalogApp().request("/api/artists/profile?artist=North%20Star&sources=local&limit=2");
    expect(profile.status).toBe(200);
    const body = await profile.json() as {
      artist: { artist: string; track_count: number; album_count: number };
      tracks: Array<Record<string, unknown>>;
       albums: Array<{ album: string; artist: string; track_count: number; cover_url?: string; source: string }>;
      available_sources: string[];
    };
    expect(body.artist).toEqual(expect.objectContaining({ artist: "North Star", track_count: 2, album_count: 2 }));
    expect(body.tracks).toHaveLength(2);
    expect(body.tracks[0]).not.toHaveProperty("local_path");
    expect(body.albums).toEqual([
      { album: "Dawn", artist: "North Star", track_count: 1, cover_url: undefined, source: "local" },
      { album: "Night", artist: "North Star", track_count: 1, cover_url: undefined, source: "local" },
    ]);
    expect(body.available_sources).toEqual(["local"]);
  });

  it("reads embedded covers and updates missing artwork from the online provider", async () => {
    const trackId = seedTrack({ id: "cover-route-track", artist: "North Star", title: "Signal" });
    const missing = await catalogApp().request(`/api/covers/${trackId}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Cover not found" });

    const unknown = await catalogApp().request("/api/covers/missing-cover");
    expect(unknown.status).toBe(404);
    const embedded = Buffer.from([0, 1, 2, 3, 4]);
    setCoverData(trackId, embedded, "image/png");
    const cover = await catalogApp().request(`/api/covers/${trackId}`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await cover.arrayBuffer())).toEqual(embedded);

    const restoreFetch = installFetchMock((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain("itunes.apple.com/search");
      return new Response(JSON.stringify({
        results: [{ artworkUrl100: "https://img.example.test/100x100bb.jpg" }],
      }), { headers: { "Content-Type": "application/json" } });
    });
    try {
      const fetched = await catalogApp().request(`/api/covers/${trackId}/fetch`);
      expect(fetched.status).toBe(200);
      expect(await fetched.json()).toEqual({
        ok: true,
        url: "https://img.example.test/600x600bb.jpg",
        source: "itunes",
      });
      expect(getDb().prepare("SELECT cover_url FROM tracks WHERE id = $id").get({ $id: trackId }))
        .toEqual({ cover_url: "https://img.example.test/600x600bb.jpg" });
    } finally {
      restoreFetch();
    }

    const noResultRestore = installFetchMock(() => new Response(JSON.stringify({ results: [], data: [] }), {
      headers: { "Content-Type": "application/json" },
    }));
    try {
      const noArtwork = await catalogApp().request(`/api/covers/${trackId}/fetch`);
      expect(await noArtwork.json()).toEqual({ ok: false, message: "No artwork found" });
    } finally {
      noResultRestore();
    }
  });
});
