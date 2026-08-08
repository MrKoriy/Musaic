import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { app } from "../index.js";
import { recommendationsRouter } from "../routes/recommendations.js";
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

function directApp(userId: string | null = null): Hono {
  const routerApp = new Hono();
  routerApp.use("*", async (c, next) => {
    if (userId) (c as any).set("userId", userId);
    await next();
  });
  routerApp.route("/api/recommendations", recommendationsRouter);
  return routerApp;
}

describe("recommendation chat", () => {
  let previousApiKey: string | undefined;
  let previousTrustProxy: string | undefined;

  beforeEach(() => {
    previousApiKey = process.env.OPENROUTER_API_KEY;
    previousTrustProxy = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = "1";
    delete process.env.OPENROUTER_API_KEY;
    setupTestDb();
  });

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousApiKey;
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
    teardownTestDb();
  });

  it("validates messages and reports an unconfigured AI service", async () => {
    const empty = await directApp().request("/api/recommendations/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "message required" });

    const unavailable = await directApp().request("/api/recommendations/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Suggest something calm" }),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: "OPENROUTER_API_KEY not configured. Add it to server/.env",
    });
  });

  it("sends taste context and history to OpenRouter and returns the reply", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    seedTrack({ id: "chat-track", title: "Signal", artist: "North Star", source: "local" });
    let requestHeaders: Headers | undefined;
    let requestPayload: Record<string, unknown> | undefined;
    const restoreFetch = installFetchMock((input, init) => {
      expect(String(input)).toContain("openrouter.ai/api/v1/chat/completions");
      requestHeaders = new Headers(init?.headers);
      requestPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "Try a late-night electronic set." } }] });
    });

    try {
      const response = await directApp("chat-user").request("/api/recommendations/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "What should I play tonight?",
          history: [{ role: "user", content: "I like electronic music." }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ reply: "Try a late-night electronic set." });
      expect(requestHeaders?.get("Authorization")).toBe("Bearer test-openrouter-key");
      expect(requestHeaders?.get("HTTP-Referer")).toBe("https://musaic.app");
      const messages = requestPayload?.messages as Array<{ role: string; content: string }>;
      expect(messages).toHaveLength(3);
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toContain("Library: 1 tracks, 1 artists.");
      expect(messages[1]).toEqual({ role: "user", content: "I like electronic music." });
      expect(messages[2]).toEqual({ role: "user", content: "What should I play tonight?" });
      expect(requestPayload?.max_tokens).toBe(500);
    } finally {
      restoreFetch();
    }
  });

  it("returns an explicit fallback when the AI upstream fails", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const restoreFetch = installFetchMock(() => new Response(null, { status: 503 }));
    try {
      const response = await directApp().request("/api/recommendations/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Find me a song" }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "AI service error: 503",
        fallback: "Please try again shortly.",
      });
    } finally {
      restoreFetch();
    }
  });

  it("requires authentication and rate-limits chat requests at the app boundary", async () => {
    const unauthorized = await app.request(new Request(
      "http://test.local/api/recommendations/chat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "198.51.100.77",
        },
        body: JSON.stringify({ message: "hello" }),
      },
    ));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "Not authenticated" });

    const rateLimitIP = "198.51.100.78";
    const responses: Response[] = [];
    for (let index = 0; index < 11; index++) {
      responses.push(await app.request(new Request(
        "http://test.local/api/recommendations/chat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": rateLimitIP,
          },
          body: JSON.stringify({ message: `message-${index}` }),
        },
      )));
    }
    expect(responses.slice(0, 10).every((response) => response.status === 401)).toBe(true);
    expect(responses[10]?.status).toBe(429);
    expect(await responses[10]!.json()).toEqual({ error: "Too Many Requests" });
  });
});
