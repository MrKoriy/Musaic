import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import searchRoutes from "../routes/search.js";
import { clearSoundCloudConfig, setSoundCloudConfig } from "../db/index.js";
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

function searchApp(): Hono {
  const routerApp = new Hono();
  routerApp.route("/api/search", searchRoutes);
  return routerApp;
}

describe("unified search", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    clearSoundCloudConfig();
    teardownTestDb();
  });

  it("validates the query and returns the response envelope", async () => {
    const missing = await searchApp().request("/api/search");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "q required" });

    const blank = await searchApp().request("/api/search?q=%20");
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: "q required" });
  });

  it("deduplicates provider results while preserving source-specific response data", async () => {
    setSoundCloudConfig({ clientId: "client-id-for-search-tests-123456", fetchedAt: Date.now() });
    const restoreFetch = installFetchMock((input) => {
      const url = requestUrl(input);
      expect(new URL(url).pathname).toBe("/search/tracks");
      return jsonResponse({
        collection: [
          {
            id: 201,
            title: "Signal",
            user: { id: 9, username: "northstar" },
            duration: 120000,
            permalink_url: "https://soundcloud.com/northstar/signal",
            artwork_url: "https://img.example.test/signal-large.jpg",
            waveform_url: null,
            streamable: true,
          },
          {
            id: 202,
            title: "Signal",
            user: { id: 9, username: "northstar" },
            duration: 120000,
            permalink_url: "https://soundcloud.com/northstar/signal-copy",
            artwork_url: null,
            waveform_url: null,
            streamable: true,
          },
        ],
      });
    });

    try {
      const response = await searchApp().request(
        "/api/search?q=signal&sources=soundcloud&limit=1&offset=1",
      );
      expect(response.status).toBe(200);
      const body = await response.json() as {
        query: string;
        offset: number;
        limit: number;
        hasMore: boolean;
        tracks: Array<Record<string, unknown>>;
        bySource: Record<string, Array<Record<string, unknown>>>;
        artists?: unknown;
      };

      expect(body.query).toBe("signal");
      expect(body.offset).toBe(1);
      expect(body.limit).toBe(1);
      expect(body.tracks).toHaveLength(1);
      expect(body.tracks[0]).toEqual(expect.objectContaining({
        id: "sc_201",
        source: "soundcloud",
        title: "Signal",
        artist: "northstar",
        duration: 120,
        cover_url: "https://img.example.test/signal-t300x300.jpg",
      }));
      expect(body.bySource.soundcloud.map((track) => track.id)).toEqual(["sc_201"]);
      expect(body.hasMore).toBe(true);
      expect(body.artists).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });

  it("normalizes bounded pagination values for an empty source selection", async () => {
    const response = await searchApp().request(
      "/api/search?q=page&sources=unknown&limit=0&offset=-100",
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      offset: number;
      limit: number;
      tracks: Array<Record<string, unknown>>;
    };
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(1);
    expect(body.tracks).toEqual([]);
  });
});
