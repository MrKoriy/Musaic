/**
 * Smart Playlists Routes
 *
 * POST /api/smart-playlists/generate   — rule-based playlist (genre, artist, year, play count)
 * POST /api/smart-playlists/ai         — AI-generated playlist from natural language prompt
 * POST /api/smart-playlists/import     — import playlist from text track list
 * GET  /api/smart-playlists/duplicates — find duplicate tracks across all playlists
 * POST /api/playlists/:id/metadata     — edit playlist name/description
 * GET  /api/playlists/:id/cover        — 4-grid cover art from track covers
 */

import { Hono } from "hono";
import { getDb, createPlaylist, addTrackToPlaylist } from "../db/index.js";
import crypto from "crypto";

const router = new Hono();

function requestUserId(c: { get(key: string): unknown }): string | null {
  return (c.get("userId") as string | undefined) ?? null;
}

function ownedPlaylist(c: { get(key: string): unknown }, id: string): boolean {
  const userId = requestUserId(c);
  if (!userId) return false;
  const row = getDb().prepare("SELECT user_id FROM playlists WHERE id = $id").get({ $id: id }) as { user_id: string | null } | null;
  return row?.user_id === userId;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "minimax/minimax-m2.5:free";
const OPENROUTER_TIMEOUT_MS = 15_000;

function getOpenRouterKey(): string | null {
  return process.env.OPENROUTER_API_KEY ?? null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SmartRule {
  field: "genre" | "artist" | "year" | "play_count" | "source" | "mood";
  op: "eq" | "contains" | "gte" | "lte" | "ne";
  value: string | number;
}

// ─── Rule engine ──────────────────────────────────────────────────────────────

function buildWhereClause(
  rules: SmartRule[]
): { where: string; params: Record<string, string | number | bigint | boolean | null> } {
  const conditions: string[] = [];
  const params: Record<string, string | number | bigint | boolean | null> = {};

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const p = `$r${i}`;

    // Map field names to actual columns
    const colMap: Record<string, string> = {
      genre: "t.genre",
      artist: "t.artist",
      mood: "t.mood",
      source: "t.source",
      year: "CAST(strftime('%Y', t.created_at, 'unixepoch') AS INTEGER)",
      play_count: "t.play_count",
    };

    const col = colMap[rule.field];
    if (!col) continue;

    switch (rule.op) {
      case "eq":
        conditions.push(`${col} = ${p}`);
        params[p] = rule.value;
        break;
      case "ne":
        conditions.push(`${col} != ${p}`);
        params[p] = rule.value;
        break;
      case "contains":
        conditions.push(`${col} LIKE ${p}`);
        params[p] = `%${rule.value}%`;
        break;
      case "gte":
        conditions.push(`${col} >= ${p}`);
        params[p] = rule.value;
        break;
      case "lte":
        conditions.push(`${col} <= ${p}`);
        params[p] = rule.value;
        break;
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

// ─── POST /generate ───────────────────────────────────────────────────────────

router.post("/generate", async (c) => {
  const body = await c.req.json<{
    name?: string;
    rules?: SmartRule[];
    limit?: number;
    sort?: "play_count" | "artist" | "title" | "created_at";
    sortDir?: "ASC" | "DESC";
    save?: boolean; // if true, persist as a playlist
  }>();

  const rules = body.rules ?? [];
  const limitRaw = Number(body.limit ?? 50);
  const limit = Math.min(Number.isFinite(limitRaw) ? Math.max(1, Math.trunc(limitRaw)) : 50, 500);
  const sort = ["play_count", "artist", "title", "created_at"].includes(body.sort ?? "")
    ? body.sort!
    : "play_count";
  const dir = body.sortDir === "ASC" ? "ASC" : "DESC";

  const db = getDb();
  const { where, params } = buildWhereClause(rules);

  const rows = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.genre, t.mood, t.source,
           t.duration, t.cover_url, t.play_count, t.last_played_at
    FROM tracks t
    ${where}
    ORDER BY t.${sort} ${dir}
    LIMIT $limit
  `).all({ ...params, $limit: limit } as any) as Array<Record<string, unknown>>;

  // Optionally persist as a playlist
  if (body.save && body.name) {
    const userId = requestUserId(c);
    const id = `smart_${crypto.randomUUID()}`;
    createPlaylist(id, body.name, `Smart playlist — ${rules.length} rule(s)`, userId);
    for (const [index, row] of rows.entries()) {
      const trackId = typeof row.id === "string" ? row.id : null;
      if (!trackId) continue;
      addTrackToPlaylist(id, trackId, index);
    }
    return c.json({ ok: true, playlistId: id, tracks: rows, count: rows.length });
  }

  return c.json({ tracks: rows, count: rows.length });
});

// ─── POST /ai ─────────────────────────────────────────────────────────────────

router.post("/ai", async (c) => {
  const body = await c.req.json<{ prompt?: string; limit?: number; save?: boolean }>();
  if (!body.prompt?.trim()) return c.json({ error: "prompt required" }, 400);

  const key = getOpenRouterKey();
  if (!key) return c.json({ error: "OPENROUTER_API_KEY not configured" }, 503);

  const limit = Math.min(Number(body.limit ?? 30), 100);
  const db = getDb();

  // Build a sample of available tracks for context
  const sample = db.prepare(
    "SELECT title, artist, genre, mood FROM tracks ORDER BY RANDOM() LIMIT 100"
  ).all() as { title: string; artist: string; genre: string | null; mood: string | null }[];

  const trackList = sample
    .map((t) => `${t.artist} - ${t.title}${t.genre ? ` (${t.genre})` : ""}`)
    .join("\n");

  const systemMsg = `You are a music playlist curator. Given a user prompt and a list of available tracks, return a JSON array of track IDs to include in the playlist.

Available tracks (artist - title):
${trackList}

Rules:
- Only include tracks from the available list
- Return ONLY a JSON array of strings: ["artist - title", ...]
- Select ${limit} tracks maximum
- Match the mood/theme of the prompt`;

  let aiTracks: string[] = [];
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: body.prompt.trim() },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices[0]?.message.content ?? "";

    // Parse JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      aiTracks = JSON.parse(jsonMatch[0]) as string[];
    }
  } catch (err: unknown) {
    return c.json({ error: `AI request failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }

  // Match AI suggestions to actual tracks in DB
  const matched: Record<string, unknown>[] = [];
  for (const suggestion of aiTracks) {
    if (matched.length >= limit) break;
    const [artist, ...titleParts] = suggestion.split(" - ");
    if (!artist) continue;
    const title = titleParts.join(" - ").trim();

    const row = db.prepare(`
      SELECT * FROM tracks
      WHERE lower(artist) LIKE lower($artist) AND lower(title) LIKE lower($title)
      LIMIT 1
    `).get({ $artist: `%${artist.trim()}%`, $title: `%${title}%` }) as Record<string, unknown> | null;
    if (row) matched.push(row);
  }

  // If AI matched fewer than expected, pad with top tracks by play_count
  if (matched.length < Math.min(limit, 10)) {
    const matchedIds = matched.map((r) => r.id as string);
    const padding = db.prepare(`
      SELECT * FROM tracks
      WHERE id NOT IN (${matchedIds.map(() => "?").join(",") || "''"})
      ORDER BY play_count DESC LIMIT ${limit - matched.length}
    `).all(...matchedIds) as Record<string, unknown>[];
    matched.push(...padding);
  }

  const name = `AI: ${body.prompt.trim().slice(0, 50)}`;
  if (body.save) {
    const userId = requestUserId(c);
    const id = `ai_${crypto.randomUUID()}`;
    createPlaylist(id, name, body.prompt.trim(), userId);
    for (let i = 0; i < matched.length; i++) {
      addTrackToPlaylist(id, matched[i]!.id as string, i);
    }
    return c.json({ ok: true, playlistId: id, name, tracks: matched, count: matched.length });
  }

  return c.json({ name, tracks: matched, count: matched.length });
});

// ─── POST /import ─────────────────────────────────────────────────────────────

/**
 * Import a playlist from a text list (one "Artist - Title" per line).
 * Fuzzy-matches against the local library.
 */
router.post("/import", async (c) => {
  const body = await c.req.json<{ name?: string; lines?: string[]; text?: string; save?: boolean }>();

  let lines: string[] = body.lines ?? [];
  if (body.text) {
    lines = body.text.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  if (!lines.length) return c.json({ error: "lines or text required" }, 400);

  const db = getDb();
  const matched: { track: Record<string, unknown>; input: string }[] = [];
  const unmatched: string[] = [];

  for (const line of lines) {
    // Try "Artist - Title" format
    const dashIdx = line.indexOf(" - ");
    let track: Record<string, unknown> | null = null;

    if (dashIdx !== -1) {
      const artist = line.slice(0, dashIdx).trim();
      const title = line.slice(dashIdx + 3).trim();
      track = db.prepare(`
        SELECT * FROM tracks
        WHERE lower(artist) LIKE lower($a) AND lower(title) LIKE lower($t)
        LIMIT 1
      `).get({ $a: `%${artist}%`, $t: `%${title}%` }) as Record<string, unknown> | null;
    }

    // Fallback: full text search via FTS
    if (!track) {
      track = db.prepare(`
        SELECT t.* FROM tracks t
        JOIN tracks_fts ON tracks_fts.rowid = t.rowid
        WHERE tracks_fts MATCH $q
        LIMIT 1
      `).get({ $q: line.replace(/[^a-zA-Z0-9 ]/g, " ") }) as Record<string, unknown> | null;
    }

    if (track) {
      matched.push({ track, input: line });
    } else {
      unmatched.push(line);
    }
  }

  const name = body.name ?? `Imported — ${new Date().toLocaleDateString()}`;
  if (body.save && matched.length > 0) {
    const userId = requestUserId(c);
    const id = `imported_${crypto.randomUUID()}`;
    createPlaylist(id, name, `Imported ${matched.length} of ${lines.length} tracks`, userId);
    for (let i = 0; i < matched.length; i++) {
      addTrackToPlaylist(id, matched[i]!.track.id as string, i);
    }
    return c.json({
      ok: true, playlistId: id, name,
      matched: matched.map((m) => ({ input: m.input, track: m.track })),
      unmatched,
    });
  }

  return c.json({
    matched: matched.map((m) => ({ input: m.input, track: m.track })),
    unmatched,
    count: matched.length,
  });
});

// ─── GET /duplicates ──────────────────────────────────────────────────────────

router.get("/duplicates", (c) => {
  const db = getDb();
  const playlistId = c.req.query("playlistId");

  let rows: Record<string, unknown>[];
  if (playlistId) {
    // Duplicates within a specific playlist
    rows = db.prepare(`
      SELECT t.id, t.title, t.artist, t.duration, COUNT(*) as occurrences
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = $pid
      GROUP BY lower(t.title), lower(t.artist)
      HAVING occurrences > 1
      ORDER BY occurrences DESC
    `).all({ $pid: playlistId }) as Record<string, unknown>[];
  } else {
    // Cross-library duplicates: same title+artist in different playlists
    rows = db.prepare(`
      SELECT t.id, t.title, t.artist, t.duration,
             GROUP_CONCAT(DISTINCT p.name) as playlists,
             COUNT(DISTINCT pt.playlist_id) as playlist_count
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      JOIN playlists p ON p.id = pt.playlist_id
      GROUP BY t.id
      HAVING playlist_count > 1
      ORDER BY playlist_count DESC
      LIMIT 100
    `).all() as Record<string, unknown>[];
  }

  return c.json({ duplicates: rows });
});

// ─── PATCH /api/playlists/:id/metadata ────────────────────────────────────────

router.patch("/metadata/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name && body.description === undefined) {
    return c.json({ error: "name or description required" }, 400);
  }

  const db = getDb();
  const userId = requestUserId(c);
  const existing = db.prepare("SELECT id, user_id FROM playlists WHERE id = $id").get({ $id: id }) as { id: string; user_id: string | null } | null;
  if (!existing) return c.json({ error: "Playlist not found" }, 404);
  if (!userId || existing.user_id !== userId) return c.json({ error: "Forbidden" }, 403);

  if (body.name) {
    db.prepare("UPDATE playlists SET name = $n, updated_at = unixepoch() WHERE id = $id")
      .run({ $n: body.name, $id: id });
  }
  if (body.description !== undefined) {
    db.prepare("UPDATE playlists SET description = $d, updated_at = unixepoch() WHERE id = $id")
      .run({ $d: body.description, $id: id });
  }

  return c.json({ ok: true });
});

export default router;
