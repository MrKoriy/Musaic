import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchLrclib, searchLrclib } from "../providers/lrclib.js";
import { fetchPlainLyrics } from "../providers/genius.js";
import {
  getArtistTags,
  getLastfmKey,
  getSimilarArtists,
  getSimilarTracks,
  getTrackTags,
  lastfmGet,
} from "../providers/lastfm.js";
import { invalidateAllCaches } from "../utils/cache.js";
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

describe("lyrics providers", () => {
  let previousGeniusToken: string | undefined;

  beforeEach(() => {
    previousGeniusToken = process.env.GENIUS_ACCESS_TOKEN;
    setupTestDb();
    invalidateAllCaches();
  });

  afterEach(() => {
    if (previousGeniusToken === undefined) delete process.env.GENIUS_ACCESS_TOKEN;
    else process.env.GENIUS_ACCESS_TOKEN = previousGeniusToken;
    invalidateAllCaches();
    teardownTestDb();
  });

  it("returns synced LRCLIB lyrics", async () => {
    const restore = installFetchMock(() => jsonResponse({
      id: 1,
      trackName: "Signal",
      artistName: "North Star",
      albumName: null,
      duration: 200,
      instrumental: false,
      plainLyrics: null,
      syncedLyrics: "[00:01.00] Signal line",
    }));
    try {
      const result = await fetchLrclib("North Star", "Signal", 200);
      expect(result).toEqual({ lrc: "[00:01.00] Signal line", source: "lrclib" });
    } finally {
      restore();
    }
  });

  it("converts plain LRCLIB lyrics and skips instrumentals and 404s", async () => {
    const restore = installFetchMock((input) => {
      const url = requestUrl(input);
      if (url.includes("track_name=Plain")) {
        return jsonResponse({
          id: 2,
          trackName: "Plain",
          artistName: "North Star",
          albumName: null,
          duration: 100,
          instrumental: false,
          plainLyrics: "Line one\nLine two",
          syncedLyrics: null,
        });
      }
      if (url.includes("track_name=Instrumental")) {
        return jsonResponse({
          id: 3,
          trackName: "Instrumental",
          artistName: "North Star",
          albumName: null,
          duration: 100,
          instrumental: true,
          plainLyrics: null,
          syncedLyrics: null,
        });
      }
      return new Response(null, { status: 404 });
    });
    try {
      expect(await fetchLrclib("North Star", "Plain", 100)).toEqual({
        lrc: "[00:00.00] Line one\n[00:00.00] Line two",
        source: "lrclib",
      });
      expect(await fetchLrclib("North Star", "Instrumental", 100)).toBeNull();
      expect(await fetchLrclib("North Star", "Missing", 100)).toBeNull();
    } finally {
      restore();
    }
  });

  it("retries LRCLIB on a 5xx response", async () => {
    let calls = 0;
    const restore = installFetchMock(() => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      return jsonResponse({
        id: 4,
        trackName: "Retry",
        artistName: "North Star",
        albumName: null,
        duration: 10,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: "[00:00.00] Retried",
      });
    });
    try {
      const result = await fetchLrclib("North Star", "Retry");
      expect(result?.lrc).toBe("[00:00.00] Retried");
      expect(calls).toBe(2);
    } finally {
      restore();
    }
  });

  it("searches LRCLIB by query", async () => {
    const restore = installFetchMock(() => jsonResponse([
      {
        id: 5,
        trackName: "Found",
        artistName: "North Star",
        albumName: null,
        duration: 10,
        instrumental: false,
        plainLyrics: null,
        syncedLyrics: "[00:00.00] Found it",
      },
    ]));
    try {
      expect(await searchLrclib("North Star Found")).toEqual({
        lrc: "[00:00.00] Found it",
        source: "lrclib",
      });
    } finally {
      restore();
    }
  });

  it("fetches Genius lyrics through search and page scraping", async () => {
    process.env.GENIUS_ACCESS_TOKEN = "genius-test-token";
    const restore = installFetchMock((input) => {
      const url = requestUrl(input);
      if (url.includes("api.genius.com/search")) {
        return jsonResponse({
          response: {
            hits: [{
              type: "song",
              result: {
                id: 10,
                title: "Signal",
                primary_artist: { name: "North Star" },
                url: "https://genius.example.test/song",
                path: "/song",
              },
            }],
          },
        });
      }
      if (url.includes("genius.example.test")) {
        return new Response(
          `<div data-lyrics-container="true"><p>First line<br>Second line</p></div>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response(null, { status: 404 });
    });
    try {
      const result = await fetchPlainLyrics("North Star", "Signal");
      expect(result?.source).toBe("genius");
      expect(result?.lyrics).toContain("First line");
    } finally {
      restore();
    }
  });

  it("falls back to lyrics.ovh without a Genius token and returns null on 404", async () => {
    delete process.env.GENIUS_ACCESS_TOKEN;
    const restore = installFetchMock((input) => {
      const url = requestUrl(input);
      if (url.includes("api.lyrics.ovh")) {
        return jsonResponse({ lyrics: "Ovh lyrics" });
      }
      return new Response(null, { status: 404 });
    });
    try {
      expect(await fetchPlainLyrics("North Star", "Signal")).toEqual({ lyrics: "Ovh lyrics", source: "lyricsovh" });
    } finally {
      restore();
    }

    const missing = installFetchMock(() => new Response(null, { status: 404 }));
    try {
      expect(await fetchPlainLyrics("North Star", "Missing")).toBeNull();
    } finally {
      missing();
    }
  });
});

describe("Last.fm provider", () => {
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env.LASTFM_API_KEY;
    process.env.LASTFM_API_KEY = "lastfm-test-key";
    setupTestDb();
    invalidateAllCaches();
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = previousKey;
    invalidateAllCaches();
    teardownTestDb();
  });

  it("exposes the configured key and rejects requests without it", async () => {
    expect(getLastfmKey()).toBe("lastfm-test-key");
    delete process.env.LASTFM_API_KEY;
    await expect(lastfmGet({ method: "track.getInfo" })).rejects.toThrow("LASTFM_API_KEY not set");
  });

  it("maps similar artists and tracks and caches the results", async () => {
    let fetches = 0;
    const restore = installFetchMock((input) => {
      const url = new URL(requestUrl(input));
      fetches++;
      const method = url.searchParams.get("method");
      if (method === "artist.getSimilar") {
        return jsonResponse({ similarartists: { artist: [{ name: "Beta", match: "0.75" }] } });
      }
      if (method === "track.getSimilar") {
        return jsonResponse({
          similartracks: { track: [{ name: "Echo", match: "0.6", artist: { name: "Gamma" } }] },
        });
      }
      return jsonResponse({});
    });
    try {
      expect(await getSimilarArtists("Alpha", 10)).toEqual([{ artist: "Beta", match: 0.75 }]);
      expect(await getSimilarTracks("Alpha", "Signal", 10)).toEqual([{ artist: "Gamma", title: "Echo", match: 0.6 }]);

      const afterFirstFetch = fetches;
      expect(await getSimilarArtists("Alpha", 5)).toEqual([{ artist: "Beta", match: 0.75 }]);
      expect(fetches).toBe(afterFirstFetch);
    } finally {
      restore();
    }
  });

  it("maps track and artist tags", async () => {
    const restore = installFetchMock((input) => {
      const method = new URL(requestUrl(input)).searchParams.get("method");
      if (method === "track.getTopTags") {
        return jsonResponse({ toptags: { tag: [{ name: "Electronic", count: 12 }] } });
      }
      return jsonResponse({ toptags: { tag: [{ name: "Ambient", count: 3 }] } });
    });
    try {
      expect(await getTrackTags("Alpha", "Signal", 5)).toEqual([{ name: "Electronic", count: 12 }]);
      expect(await getArtistTags("Alpha", 5)).toEqual([{ name: "Ambient", count: 3 }]);
    } finally {
      restore();
    }
  });
});
