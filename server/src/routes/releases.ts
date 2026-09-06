import { Hono } from "hono";
import { getDb } from "../db/index.js";

export const releasesRouter = new Hono();

export interface ReleaseRow {
  id: string;
  artist: string;
  title: string;
  year: number | null;
  coverUrl: string | null;
  trackCount: number | null;
  firstSeenAt: number;
  notifiedAt: number | null;
}

function toRelease(row: Record<string, unknown>): ReleaseRow {
  return {
    id: String(row.id ?? ""),
    artist: String(row.artist ?? ""),
    title: String(row.title ?? ""),
    year: row.year == null ? null : Number(row.year),
    coverUrl: row.cover_url == null ? null : String(row.cover_url),
    trackCount: row.track_count == null ? null : Number(row.track_count),
    firstSeenAt: Number(row.first_seen_at ?? 0),
    notifiedAt: row.notified_at == null ? null : Number(row.notified_at),
  };
}

// New releases not yet surfaced to the client (notified_at is NULL).
releasesRouter.get("/new", (c) => {
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 50), 200));
  const rows = getDb()
    .prepare(`
      SELECT id, artist, title, year, cover_url, track_count, first_seen_at, notified_at
      FROM artist_releases
      WHERE notified_at IS NULL
      ORDER BY first_seen_at DESC
      LIMIT $limit
    `)
    .all({ $limit: limit }) as Record<string, unknown>[];
  return c.json({ releases: rows.map(toRelease) });
});

// Mark releases as surfaced so they are not returned again.
releasesRouter.post("/ack", async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({ ids: [] }));
  const ids = (body.ids ?? []).filter((id) => typeof id === "string" && id.length > 0).slice(0, 500);
  if (ids.length === 0) return c.json({ acked: 0 });
  const placeholders = ids.map((_, i) => `$id${i}`).join(", ");
  const params = Object.fromEntries(ids.map((id, i) => [`$id${i}`, id]));
  const result = getDb()
    .prepare(`
      UPDATE artist_releases
      SET notified_at = unixepoch()
      WHERE id IN (${placeholders}) AND notified_at IS NULL
    `)
    .run(params) as { changes?: number };
  return c.json({ acked: Number(result.changes ?? 0) });
});
