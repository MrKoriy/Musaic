/**
 * Unified search route — merges results from all providers
 */

import { Hono } from "hono";
import { getVKProvider } from "../providers/vk.js";
import { getLocalProvider } from "../providers/local.js";
import { getSoundCloudProvider } from "../providers/soundcloud.js";
import type { Track } from "../types.js";

const router = new Hono();

/**
 * GET /api/search?q=query&sources=local,vk,soundcloud
 */
router.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "q required" }, 400);

  const sourcesParam = c.req.query("sources") ?? "local,vk,soundcloud";
  const sources = sourcesParam.split(",").map((s) => s.trim());

  const results: Record<string, Track[]> = {};
  const errors: Record<string, string> = {};

  const tasks: Promise<void>[] = [];

  if (sources.includes("local")) {
    tasks.push(
      getLocalProvider()
        .search(q)
        .then((t) => { results.local = t; })
        .catch((e: unknown) => { errors.local = e instanceof Error ? e.message : String(e); })
    );
  }

  if (sources.includes("vk") && getVKProvider().isAuthenticated()) {
    tasks.push(
      getVKProvider()
        .search(q)
        .then((t) => { results.vk = t; })
        .catch((e: unknown) => { errors.vk = e instanceof Error ? e.message : String(e); })
    );
  }

  if (sources.includes("soundcloud")) {
    tasks.push(
      getSoundCloudProvider()
        .search(q)
        .then((t) => { results.soundcloud = t; })
        .catch((e: unknown) => { errors.soundcloud = e instanceof Error ? e.message : String(e); })
    );
  }

  await Promise.all(tasks);

  // Merge: local first (best quality), then VK, then SoundCloud
  const merged: Track[] = [
    ...(results.local ?? []),
    ...(results.vk ?? []),
    ...(results.soundcloud ?? []),
  ];

  return c.json({
    query: q,
    tracks: merged,
    bySource: results,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
});

export default router;
