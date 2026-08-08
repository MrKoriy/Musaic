import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "../index.js";
import { getDb, setCachedVkUrl } from "../db/index.js";
import { streamTrack, StreamProxyError } from "../utils/stream-proxy.js";
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function registerForApp(): Promise<string> {
  const response = await app.request(new Request("http://test.local/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({ username: `stream_${Math.random().toString(36).slice(2, 9)}`, password: "password-123" }),
  }));
  expect(response.status).toBe(200);
  return (await response.json() as { token: string }).token;
}

describe("unified stream proxy", () => {
  let directory: string;
  let originalMusicDir: string | undefined;
  let originalTrustProxy: string | undefined;

  beforeEach(async () => {
    originalTrustProxy = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "1";
    setupTestDb();
    originalMusicDir = process.env.MUSIC_DIR;
    directory = await mkdtemp(path.join(os.tmpdir(), "musaic-stream-"));
    process.env.MUSIC_DIR = directory;
  });

  afterEach(async () => {
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
    if (originalMusicDir === undefined) delete process.env.MUSIC_DIR;
    else process.env.MUSIC_DIR = originalMusicDir;
    await rm(directory, { recursive: true, force: true });
    teardownTestDb();
  });

  it("serves local bytes and valid ranges without exposing filesystem paths", async () => {
    const filePath = path.join(directory, "track.mp3");
    await writeFile(filePath, Buffer.from("0123456789", "ascii"));
    const trackId = seedTrack({ id: "stream-local", source: "local" });
    getDb().prepare("UPDATE tracks SET local_path = $path WHERE id = $id").run({ $path: filePath, $id: trackId });

    const response = await streamTrack({ source: "local", trackId, range: "bytes=2-5" });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
  });

  it("rejects unsatisfied ranges and files outside configured roots", async () => {
    const filePath = path.join(directory, "track.mp3");
    await writeFile(filePath, Buffer.from("audio", "ascii"));
    const trackId = seedTrack({ id: "stream-invalid", source: "local" });
    getDb().prepare("UPDATE tracks SET local_path = $path WHERE id = $id").run({ $path: filePath, $id: trackId });

    const invalidRange = await streamTrack({ source: "local", trackId, range: "bytes=50-60" });
    expect(invalidRange.status).toBe(416);

    process.env.MUSIC_DIR = path.join(directory, "other");
    await expect(streamTrack({ source: "local", trackId })).rejects.toBeInstanceOf(StreamProxyError);
  });

  it("proxies a VK stream from the cached URL and forwards the range", async () => {
    const trackId = seedTrack({ id: "stream-vk", source: "vk" });
    setCachedVkUrl(trackId, "https://cdn.example.test/vk.mp3");
    const restore = installFetchMock((input) => {
      expect(String(input)).toBe("https://cdn.example.test/vk.mp3");
      return new Response("cdef", {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Range": "bytes 2-5/10",
          "Accept-Ranges": "bytes",
        },
      });
    });
    try {
      const response = await streamTrack({ source: "vk", trackId, range: "bytes=2-5" });
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe("cdef");
    } finally {
      restore();
    }
  });

  it("proxies a YouTube stream through the sidecar without tokens in URLs", async () => {
    process.env.MUSAIC_SECRET_KEY = "stream-secret";
    const trackId = seedTrack({ id: "stream-yt", source: "youtube" });
    const restore = installFetchMock((input) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response(null, { status: 200 });
      if (url.includes("/yt/stream/")) return jsonResponse({ url: "https://googlevideo.example.test/audio.mp4" });
      return new Response("audio-bytes", { status: 200, headers: { "Content-Type": "audio/mp4" } });
    });
    try {
      const response = await streamTrack({ source: "youtube", trackId });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("audio-bytes");
    } finally {
      restore();
    }
  });

  it("rejects unsupported sources and upstream failures", async () => {
    await expect(streamTrack({ source: "bogus", trackId: "x" })).rejects.toThrow("Unsupported stream source: bogus");

    const trackId = seedTrack({ id: "stream-vk-error", source: "vk" });
    setCachedVkUrl(trackId, "https://cdn.example.test/fail.mp3");
    const restore = installFetchMock(() => new Response(null, { status: 503 }));
    try {
      await expect(streamTrack({ source: "vk", trackId })).rejects.toBeInstanceOf(StreamProxyError);
    } finally {
      restore();
    }
  });

  it("serves the unified authenticated route and rejects invalid targets", async () => {
    const token = await registerForApp();
    const bad = await app.request(new Request(
      "http://test.local/api/stream/bogus/x",
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(bad.status).toBe(400);

    const filePath = path.join(directory, "route.mp3");
    await writeFile(filePath, Buffer.from("0123456789", "ascii"));
    const trackId = seedTrack({ id: "route-local", source: "local" });
    getDb().prepare("UPDATE tracks SET local_path = $path WHERE id = $id").run({ $path: filePath, $id: trackId });

    const ok = await app.request(new Request(
      `http://test.local/api/stream/local/${trackId}`,
      { headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-3" } },
    ));
    expect(ok.status).toBe(206);
    expect(await ok.text()).toBe("0123");
  });
});
