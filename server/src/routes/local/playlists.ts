import { Hono } from "hono";
import crypto from "crypto";
import {
  getDb,
  getPlaylists,
  normalizePlaylistRow,
  createPlaylist,
  deletePlaylist,
  getPlaylistTracks,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  setPlaylistCoverData,
  getPlaylistCoverData,
  clearPlaylistCoverData,
} from "../../db/index.js";

function playlistOwnershipCheck(
  id: string,
  userId: string | undefined
): { status: number; error: string } | null {
  const db = getDb();
  const row = db.prepare("SELECT user_id FROM playlists WHERE id = $id")
    .get({ $id: id }) as { user_id: string | null } | null;
  if (!row) return { status: 404, error: "Playlist not found" };
  if (row.user_id && row.user_id !== userId) return { status: 403, error: "Forbidden" };
  return null;
}

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function validateImageMagicBytes(data: Buffer, mimeType: string): boolean {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(mime)) return false;
  if (data.length < 12) return false;
  if (mime === "image/jpeg") return data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;
  if (mime === "image/png") {
    return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47 &&
           data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A;
  }
  if (mime === "image/gif") return data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38;
  if (mime === "image/webp") {
    return data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
           data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;
  }
  return false;
}

export const playlistsRouter = new Hono();

playlistsRouter.get("/", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  return c.json({ playlists: getPlaylists(userId) });
});

playlistsRouter.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = "playlist_" + crypto.randomBytes(8).toString("hex");
  const userId = (c as any).get("userId") as string | undefined;
  createPlaylist(id, body.name.trim(), body.description, userId);
  return c.json({ ok: true, id });
});

playlistsRouter.delete("/:id", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  const ownerErr = playlistOwnershipCheck(c.req.param("id"), userId);
  if (ownerErr) return c.json({ error: ownerErr.error }, ownerErr.status as any);
  deletePlaylist(c.req.param("id"));
  return c.json({ ok: true });
});

playlistsRouter.get("/:id/tracks", (c) => {
  return c.json({ tracks: getPlaylistTracks(c.req.param("id")) });
});

playlistsRouter.post("/:id/tracks", async (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  const ownerErr = playlistOwnershipCheck(c.req.param("id"), userId);
  if (ownerErr) return c.json({ error: ownerErr.error }, ownerErr.status as any);
  const body = await c.req.json<{ trackId?: string; position?: number }>();
  if (!body.trackId) return c.json({ error: "trackId required" }, 400);
  const tracks = getPlaylistTracks(c.req.param("id"));
  addTrackToPlaylist(c.req.param("id"), body.trackId, body.position ?? tracks.length);
  return c.json({ ok: true });
});

playlistsRouter.delete("/:id/tracks/:trackId", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  const ownerErr = playlistOwnershipCheck(c.req.param("id"), userId);
  if (ownerErr) return c.json({ error: ownerErr.error }, ownerErr.status as any);
  removeTrackFromPlaylist(c.req.param("id"), c.req.param("trackId"));
  return c.json({ ok: true });
});

playlistsRouter.post("/:id/image", async (c) => {
  const id = c.req.param("id");
  const userId = (c as any).get("userId") as string | undefined;
  const ownerErr = playlistOwnershipCheck(id, userId);
  if (ownerErr) return c.json({ error: ownerErr.error }, ownerErr.status as any);

  const body = await c.req.json<{ imageBase64?: string; mimeType?: string }>();
  const mime = body.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!body.imageBase64 || !ALLOWED_IMAGE_MIMES.has(mime)) {
    return c.json({ error: "imageBase64 and mimeType (jpeg/png/gif/webp) required" }, 400);
  }

  let data: Buffer;
  try {
    data = Buffer.from(body.imageBase64, "base64");
  } catch {
    return c.json({ error: "Invalid imageBase64 payload" }, 400);
  }
  if (!data.length || data.length > 4 * 1024 * 1024) {
    return c.json({ error: "Image is empty or exceeds 4MB" }, 400);
  }
  if (!validateImageMagicBytes(data, mime)) {
    return c.json({ error: "Image data does not match declared MIME type" }, 400);
  }

  setPlaylistCoverData(id, data, mime);
  return c.json({ ok: true, cover_url: `/api/playlists/${encodeURIComponent(id)}/image` });
});

playlistsRouter.get("/:id/image", (c) => {
  const id = c.req.param("id");
  const cover = getPlaylistCoverData(id);
  if (!cover) return c.json({ error: "Cover not found" }, 404);

  return new Response(new Uint8Array(cover.data), {
    status: 200,
    headers: {
      "Content-Type": cover.mimeType,
      "Cache-Control": "public, max-age=604800",
    },
  });
});

playlistsRouter.delete("/:id/image", (c) => {
  const userId = (c as any).get("userId") as string | undefined;
  const ownerErr = playlistOwnershipCheck(c.req.param("id"), userId);
  if (ownerErr) return c.json({ error: ownerErr.error }, ownerErr.status as any);
  clearPlaylistCoverData(c.req.param("id"));
  return c.json({ ok: true });
});

playlistsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const userId = (c as any).get("userId") as string | undefined;
  const ownerErr = playlistOwnershipCheck(id, userId);
  if (ownerErr) return c.json({ error: ownerErr.error }, ownerErr.status as any);
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name && body.description === undefined) {
    return c.json({ error: "name or description required" }, 400);
  }
  const db = getDb();

  if (body.name?.trim()) {
    db.prepare("UPDATE playlists SET name = $n, updated_at = unixepoch() WHERE id = $id")
      .run({ $n: body.name.trim(), $id: id });
  }
  if (body.description !== undefined) {
    db.prepare("UPDATE playlists SET description = $d, updated_at = unixepoch() WHERE id = $id")
      .run({ $d: body.description, $id: id });
  }
  return c.json({ ok: true });
});

playlistsRouter.get("/:id/cover", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.cover_url FROM tracks t
    JOIN playlist_tracks pt ON t.id = pt.track_id
    WHERE pt.playlist_id = $pid AND t.cover_url IS NOT NULL
    ORDER BY pt.position ASC
    LIMIT 4
  `).all({ $pid: id }) as { cover_url: string }[];

  return c.json({ covers: rows.map((r) => r.cover_url) });
});

playlistsRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const playlist = db.prepare(`
    SELECT
      p.*,
      COUNT(pt.track_id) as track_count,
      CASE WHEN pcd.playlist_id IS NOT NULL THEN 1 ELSE 0 END as has_custom_cover,
      COALESCE(
        CASE
          WHEN pcd.playlist_id IS NOT NULL THEN '/api/playlists/' || p.id || '/image'
          ELSE NULL
        END,
        (
          SELECT t.cover_url
          FROM playlist_tracks pt2
          JOIN tracks t ON t.id = pt2.track_id
          WHERE pt2.playlist_id = p.id AND t.cover_url IS NOT NULL
          ORDER BY pt2.position ASC
          LIMIT 1
        )
      ) as cover_url
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
    LEFT JOIN playlist_cover_data pcd ON p.id = pcd.playlist_id
    WHERE p.id = $id
    GROUP BY p.id
  `).get({ $id: id }) as Record<string, unknown> | null;
  if (!playlist) return c.json({ error: "Not found" }, 404);
  return c.json({ playlist: normalizePlaylistRow(playlist) });
});
