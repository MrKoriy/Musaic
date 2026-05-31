/**
 * Playlists CRUD endpoint tests
 *
 * Tests /api/playlists routes: list, create, delete, add/remove tracks,
 * and the single-playlist GET.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { playlistsRouter } from "../routes/local.js";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";

function buildApp() {
  const app = new Hono();
  app.route("/api/playlists", playlistsRouter);
  return app;
}

async function createPlaylist(app: Hono, name: string): Promise<string> {
  const res = await app.request("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await res.json() as { id: string };
  return body.id;
}

describe("Playlists API", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  // ── List ────────────────────────────────────────────────────────────────

  it("GET /api/playlists — returns empty list initially", async () => {
    const res = await buildApp().request("/api/playlists");
    expect(res.status).toBe(200);
    const body = await res.json() as { playlists: unknown[] };
    expect(Array.isArray(body.playlists)).toBe(true);
    expect(body.playlists).toHaveLength(0);
  });

  // ── Create ───────────────────────────────────────────────────────────────

  it("POST /api/playlists — creates a playlist", async () => {
    const res = await buildApp().request("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Playlist" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^playlist_/);
  });

  it("POST /api/playlists — rejects missing name", async () => {
    const res = await buildApp().request("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no name" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/name required/i);
  });

  it("POST /api/playlists — rejects blank name", async () => {
    const res = await buildApp().request("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  // ── Get single ───────────────────────────────────────────────────────────

  it("GET /api/playlists/:id — returns created playlist", async () => {
    const app = buildApp();
    const createRes = await app.request("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rock Mix", description: "Heavy stuff" }),
    });
    const { id } = await createRes.json() as { id: string };

    const getRes = await app.request(`/api/playlists/${id}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { playlist: { id: string; name: string; track_count: number } };
    expect(body.playlist.id).toBe(id);
    expect(body.playlist.name).toBe("Rock Mix");
    expect(body.playlist.track_count).toBe(0);
  });

  it("GET /api/playlists/:id — 404 for unknown id", async () => {
    const res = await buildApp().request("/api/playlists/playlist_notexist");
    expect(res.status).toBe(404);
  });

  // ── Delete ───────────────────────────────────────────────────────────────

  it("DELETE /api/playlists/:id — removes the playlist", async () => {
    const app = buildApp();
    const id = await createPlaylist(app, "To Delete");

    const delRes = await app.request(`/api/playlists/${id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const body = await delRes.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Confirm it's gone
    const getRes = await app.request(`/api/playlists/${id}`);
    expect(getRes.status).toBe(404);
  });

  // ── Tracks ────────────────────────────────────────────────────────────────

  it("GET /api/playlists/:id/tracks — empty initially", async () => {
    const app = buildApp();
    const id = await createPlaylist(app, "Empty");

    const res = await app.request(`/api/playlists/${id}/tracks`);
    expect(res.status).toBe(200);
    const body = await res.json() as { tracks: unknown[] };
    expect(body.tracks).toHaveLength(0);
  });

  it("POST /api/playlists/:id/tracks — adds track to playlist", async () => {
    const app = buildApp();
    const trackId = seedTrack({ title: "Test Song", artist: "Test Artist" });

    const id = await createPlaylist(app, "My Mix");

    const addRes = await app.request(`/api/playlists/${id}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId }),
    });
    expect(addRes.status).toBe(200);
    const addBody = await addRes.json() as { ok: boolean };
    expect(addBody.ok).toBe(true);

    // Verify track appears in list
    const tracksRes = await app.request(`/api/playlists/${id}/tracks`);
    const tracksBody = await tracksRes.json() as { tracks: { id: string }[] };
    expect(tracksBody.tracks).toHaveLength(1);
    expect(tracksBody.tracks[0].id).toBe(trackId);
  });

  it("DELETE /api/playlists/:id/tracks/:trackId — removes track", async () => {
    const app = buildApp();
    const trackId = seedTrack();

    const id = await createPlaylist(app, "Mix");

    await app.request(`/api/playlists/${id}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId }),
    });

    const delRes = await app.request(`/api/playlists/${id}/tracks/${trackId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    const tracksRes = await app.request(`/api/playlists/${id}/tracks`);
    const tracksBody = await tracksRes.json() as { tracks: unknown[] };
    expect(tracksBody.tracks).toHaveLength(0);
  });

  it("POST /api/playlists/:id/tracks — rejects missing trackId", async () => {
    const app = buildApp();
    const id = await createPlaylist(app, "Mix");

    const res = await app.request(`/api/playlists/${id}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // ── Update ────────────────────────────────────────────────────────────────

  it("PATCH /api/playlists/:id — updates playlist name", async () => {
    const app = buildApp();
    const id = await createPlaylist(app, "Old Name");

    const patchRes = await app.request(`/api/playlists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(patchRes.status).toBe(200);

    const getRes = await app.request(`/api/playlists/${id}`);
    const body = await getRes.json() as { playlist: { name: string } };
    expect(body.playlist.name).toBe("New Name");
  });

  // ── List after creation ───────────────────────────────────────────────────

  it("GET /api/playlists — returns all created playlists", async () => {
    const app = buildApp();
    await app.request("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Playlist A" }),
    });
    await app.request("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Playlist B" }),
    });

    const res = await app.request("/api/playlists");
    const body = await res.json() as { playlists: { name: string }[] };
    expect(body.playlists).toHaveLength(2);
    const names = body.playlists.map((p) => p.name).sort();
    expect(names).toEqual(["Playlist A", "Playlist B"]);
  });
});
