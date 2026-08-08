import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { app } from "../index.js";
import { downloadsRouter } from "../routes/local/downloads.js";
import { getDb } from "../db/index.js";
import { seedTrack, setupTestDb, teardownTestDb } from "./setup.js";

function downloadsApp(): Hono {
  const routerApp = new Hono();
  routerApp.route("/api/downloads", downloadsRouter);
  return routerApp;
}

async function registerForApp(): Promise<string> {
  const response = await app.request(new Request("http://test.local/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "198.51.100.74",
    },
    body: JSON.stringify({
      username: `downloads_${Math.random().toString(36).slice(2, 9)}`,
      password: "password-123",
    }),
  }));
  expect(response.status).toBe(200);
  return (await response.json() as { token: string }).token;
}

describe("local and cached downloads", () => {
  const tempDirs: string[] = [];
  const originalMusicDir = process.env.MUSIC_DIR;

  beforeEach(setupTestDb);

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    if (originalMusicDir === undefined) delete process.env.MUSIC_DIR;
    else process.env.MUSIC_DIR = originalMusicDir;
    teardownTestDb();
  });

  it("serves local audio ranges with correct bytes and headers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "musaic-downloads-"));
    tempDirs.push(directory);
    const filePath = path.join(directory, "signal.mp3");
    const bytes = Buffer.from("0123456789", "ascii");
    await writeFile(filePath, bytes);

    const trackID = seedTrack({ id: "local-download", source: "local" });
    getDb().prepare("UPDATE tracks SET local_path = $path WHERE id = $id")
      .run({ $path: filePath, $id: trackID });
    process.env.MUSIC_DIR = directory;

    const response = await downloadsApp().request(`/api/downloads/stream/${trackID}`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("2345", "ascii"));

    const full = await downloadsApp().request(`/api/downloads/stream/${trackID}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Length")).toBe("10");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  });

  it("returns missing-track semantics and does not resolve encoded traversal IDs", async () => {
    const missing = await downloadsApp().request("/api/downloads/stream/%2e%2e%2Foutside");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Invalid track ID" });

    const compressedMissing = await downloadsApp().request("/api/downloads/compressed/unknown");
    expect(compressedMissing.status).toBe(404);
    expect(await compressedMissing.json()).toEqual({ error: "Track not found" });
  });

  it("requires auth for downloads and rejects traversal before file access", async () => {
    const anonymous = await app.request(new Request(
      "http://test.local/api/downloads/stream/local-download",
      { headers: { "x-forwarded-for": "198.51.100.75" } },
    ));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Not authenticated" });

    const token = await registerForApp();
    const traversal = await app.request(new Request(
      "http://test.local/audio/local/%2e%2e%2Fetc%2Fpasswd",
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toEqual({ error: "Invalid track ID" });
  });
});
