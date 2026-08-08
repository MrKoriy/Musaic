import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { app } from "../index.js";
import yandexRoutes from "../routes/yandex.js";
import { getDb } from "../db/index.js";
import { getYandexProvider } from "../providers/yandex.js";
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
  routerApp.route("/api/yandex", yandexRoutes);
  return routerApp;
}

describe("Yandex provider and routes", () => {
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.MUSAIC_SECRET_KEY;
    process.env.MUSAIC_SECRET_KEY = "test-config-secret";
    setupTestDb();
  });

  afterEach(() => {
    getYandexProvider().logout();
    if (previousSecret === undefined) delete process.env.MUSAIC_SECRET_KEY;
    else process.env.MUSAIC_SECRET_KEY = previousSecret;
    teardownTestDb();
  });

  it("keeps account tokens out of generated stream URLs", async () => {
    const provider = getYandexProvider();
    provider.logout();

    await expect(provider.getStreamUrl("yandex_123", { codec: "aac", bitrate: 192 }))
      .resolves.toBe("/api/yandex/proxy/123?codec=aac&bitrate=192");
    const url = await provider.getStreamUrl("yandex_123");
    expect(url).not.toContain("token");
    expect(url).not.toContain("secret");

    const restoreFetch = installFetchMock(() => {
      throw new Error("a missing Yandex token must fail before network access");
    });
    try {
      await expect(provider.stream("yandex_123")).rejects.toThrow("Yandex is not connected");
    } finally {
      restoreFetch();
    }

    const status = await providerApp().request("/api/yandex/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ authenticated: false, username: null });
  });

  it("sends the token to the sidecar in a header and caches mapped search tracks", async () => {
    const provider = getYandexProvider();
    provider.setToken("yandex-account-token", "yandex-user");
    process.env.MUSAIC_SECRET_KEY = "test-sidecar-secret";
    const requests: Array<{ url: string; headers: Headers }> = [];
    const restoreFetch = installFetchMock((input, init) => {
      const url = requestUrl(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/health")) return new Response(null, { status: 200 });
      return jsonResponse({
        tracks: [{
          id: "yandex_55",
          source: "yandex",
          title: "Signal",
          artist: "North Star",
          album: "Night Drive",
          genre: "Electronic",
          duration: 201,
          coverUrl: "https://img.example.test/yandex.jpg",
        }],
      });
    });

    try {
      const tracks = await provider.search("north star", { limit: 2, offset: 2 });
      expect(tracks).toEqual([expect.objectContaining({
        id: "yandex_55",
        source: "yandex",
        title: "Signal",
        artist: "North Star",
        duration: 201,
        coverUrl: "https://img.example.test/yandex.jpg",
      })]);

      const sidecarRequest = requests.find((request) => request.url.includes("/yandex/search"));
      expect(sidecarRequest).toBeDefined();
      const parsed = new URL(sidecarRequest!.url);
      expect(parsed.searchParams.get("q")).toBe("north star");
      expect(parsed.searchParams.get("count")).toBe("2");
      expect(parsed.searchParams.get("page")).toBe("1");
      expect(sidecarRequest!.headers.get("X-Yandex-Token")).toBe("yandex-account-token");
      expect(sidecarRequest!.headers.get("X-Musaic-Secret")).toBe("test-sidecar-secret");

      expect(getDb().prepare("SELECT source, title, artist, genre FROM tracks WHERE id = $id")
        .get({ $id: "yandex_55" })).toEqual({
          source: "yandex",
          title: "Signal",
          artist: "North Star",
          genre: "Electronic",
        });
    } finally {
      restoreFetch();
    }
  });

  it("proxies a Yandex range response while preserving audio semantics", async () => {
    const provider = getYandexProvider();
    provider.setToken("yandex-account-token", "yandex-user");
    process.env.MUSAIC_SECRET_KEY = "test-sidecar-secret";
    let downloadRequest: { url: string; headers: Headers } | undefined;
    const restoreFetch = installFetchMock((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/health")) return new Response(null, { status: 200 });
      downloadRequest = { url, headers: new Headers(init?.headers) };
      return new Response("def", {
        status: 206,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": "3",
          "Content-Range": "bytes 3-5/9",
          "Accept-Ranges": "bytes",
        },
      });
    });

    try {
      const response = await providerApp().request("/api/yandex/proxy/yandex_123", {
        headers: { Range: "bytes=3-5" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(response.headers.get("Content-Range")).toBe("bytes 3-5/9");
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).toBe("def");
      expect(downloadRequest).toBeDefined();
      expect(downloadRequest!.url).not.toContain("yandex-account-token");
      expect(downloadRequest!.headers.get("X-Yandex-Token")).toBe("yandex-account-token");
      expect(downloadRequest!.headers.get("Range")).toBe("bytes=3-5");
    } finally {
      restoreFetch();
    }
  });

  it("returns validation, missing-token, and middleware auth responses", async () => {
    const missingToken = await providerApp().request("/api/yandex/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingToken.status).toBe(400);
    expect(await missingToken.json()).toEqual({ error: "token required" });

    const noConnection = await providerApp().request("/api/yandex/proxy/yandex_123");
    expect(noConnection.status).toBe(500);
    expect(await noConnection.json()).toEqual({
      error: "Yandex is not connected. Add your Yandex token in Settings.",
    });

    const protectedResponse = await app.request(new Request(
      "http://test.local/api/yandex/proxy/yandex_123",
      { headers: { "x-forwarded-for": "198.51.100.72" } },
    ));
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.json()).toEqual({ error: "Not authenticated" });
  });
});
