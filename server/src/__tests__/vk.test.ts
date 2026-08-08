import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { app } from "../index.js";
import vkRoutes from "../routes/vk.js";
import { getDb, getVkConfig, setCachedVkUrl } from "../db/index.js";
import { getVKProvider, VKMusicProvider } from "../providers/vk.js";
import { setupTestDb, teardownTestDb } from "./setup.js";

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

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function providerApp(): Hono {
  const routerApp = new Hono();
  routerApp.route("/api/vk", vkRoutes);
  return routerApp;
}

describe("VK provider and routes", () => {
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.MUSAIC_SECRET_KEY;
    process.env.MUSAIC_SECRET_KEY = "test-config-secret";
    setupTestDb();
  });

  afterEach(() => {
    getVKProvider().logout();
    if (previousSecret === undefined) delete process.env.MUSAIC_SECRET_KEY;
    else process.env.MUSAIC_SECRET_KEY = previousSecret;
    teardownTestDb();
  });

  it("maps search results, caches them, and returns stream metadata", async () => {
    const provider = getVKProvider();
    provider.setToken("vk-test-token", "vk-user");
    let requestedURL = "";
    const restoreFetch = installFetchMock((input) => {
      requestedURL = requestUrl(input);
      return jsonResponse({
        response: {
          count: 1,
          items: [{
            id: 42,
            owner_id: 7,
            title: "  Signal  ",
            artist: "North Star",
            duration: 187,
            url: "https://cdn.example.test/signal.mp3",
            photo_600: "https://img.example.test/signal.jpg",
            album: { id: 3, title: "Night Drive" },
          }],
        },
      });
    });

    try {
      const response = await providerApp().request("/api/vk/search?q=signal");
      expect(response.status).toBe(200);
      const body = await response.json() as {
        tracks: Array<Record<string, unknown>>;
      };

      expect(new URL(requestedURL).pathname).toBe("/method/audio.search");
      expect(new URL(requestedURL).searchParams.get("q")).toBe("signal");
      expect(body.tracks).toHaveLength(1);
      expect(body.tracks[0]).toEqual(expect.objectContaining({
        id: "vk_7_42",
        source: "vk",
        title: "Signal",
        artist: "North Star",
        album: "Night Drive",
        duration: 187,
        coverUrl: "https://img.example.test/signal.jpg",
        streamUrl: "https://cdn.example.test/signal.mp3",
      }));

      const cached = getDb().prepare(
        "SELECT source, title, artist, album FROM tracks WHERE id = $id",
      ).get({ $id: "vk_7_42" }) as Record<string, unknown>;
      expect(cached).toEqual({
        source: "vk",
        title: "Signal",
        artist: "North Star",
        album: "Night Drive",
      });
      expect(getDb().prepare("SELECT url FROM vk_audio_urls WHERE track_id = $id")
        .get({ $id: "vk_7_42" })).toEqual({ url: "https://cdn.example.test/signal.mp3" });
    } finally {
      restoreFetch();
    }
  });

  it("returns useful validation and authentication errors", async () => {
    const missingQuery = await providerApp().request("/api/vk/search");
    expect(missingQuery.status).toBe(400);
    expect(await missingQuery.json()).toEqual({ error: "q required" });

    getVKProvider().logout();
    const unavailable = await providerApp().request("/api/vk/search?q=signal");
    expect(unavailable.status).toBe(500);
    const unavailableBody = await unavailable.json() as { error: string };
    expect(unavailableBody.error).toContain("VK not authenticated");

    const protectedResponse = await app.request(new Request(
      "http://test.local/api/vk/stream/vk_7_42",
      { headers: { "x-forwarded-for": "198.51.100.71" } },
    ));
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.json()).toEqual({ error: "Not authenticated" });
  });

  it("clears an invalid token after an upstream HTTP 401", async () => {
    const provider = new VKMusicProvider();
    provider.setToken("expired-token", "vk-user");
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls++;
      return new Response(null, { status: 401 });
    });

    try {
      await expect(provider.search("signal")).rejects.toThrow("VK token expired or invalid");
      expect(calls).toBe(1);
      expect(provider.isAuthenticated()).toBe(false);
      expect(getVkConfig().token).toBeNull();
    } finally {
      provider.logout();
      restoreFetch();
    }
  });

  it("uses a cached stream URL without making another provider request", async () => {
    const provider = new VKMusicProvider();
    provider.setToken("vk-test-token", "vk-user");
    setCachedVkUrl("vk_7_42", "https://cdn.example.test/cached.mp3");
    const restoreFetch = installFetchMock(() => {
      throw new Error("cached VK URL should not fetch");
    });

    try {
      await expect(provider.getStreamUrl("vk_7_42")).resolves.toBe("https://cdn.example.test/cached.mp3");
    } finally {
      provider.logout();
      restoreFetch();
    }
  });
});
