/**
 * Stats Routes — listening analytics aggregation
 *
 * GET /api/stats/overview   — totals, streaks, top track/artist
 * GET /api/stats/top-tracks — top tracks by play count
 * GET /api/stats/top-artists — top artists by play count
 * GET /api/stats/top-albums  — top albums by play count
 * GET /api/stats/heatmap     — play counts by hour of day
 * GET /api/stats/monthly     — daily play counts for current month
 */

import { Hono } from "hono";
import { getDb } from "../db/index.js";

const router = new Hono();

const VALID_PERIODS = ["today", "week", "month", "alltime"] as const;
type Period = (typeof VALID_PERIODS)[number];

function validatePeriod(raw: string | undefined): Period {
  const p = raw ?? "alltime";
  return VALID_PERIODS.includes(p as Period) ? (p as Period) : "alltime";
}

function startOfDayUnix(daysAgo = 0): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return Math.floor(d.getTime() / 1000);
}

function startOfMonthUnix(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Returns the unix timestamp cutoff for a given period, or null for alltime */
function periodCutoff(period: Period): number | null {
  if (period === "today") return startOfDayUnix(0);
  if (period === "week") return startOfDayUnix(6);
  if (period === "month") return startOfMonthUnix();
  return null;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

router.get("/overview", (c) => {
  const db = getDb();

  const todayStart = startOfDayUnix(0);
  const weekStart = startOfDayUnix(6);
  const monthStart = startOfMonthUnix();

  const countQ = db.prepare(
    `SELECT COUNT(*) as n FROM listening_history WHERE action IN ('play', 'complete') AND played_at >= $from`
  );
  const countAll = db.prepare(
    `SELECT COUNT(*) as n FROM listening_history WHERE action IN ('play', 'complete')`
  );

  const totalCount = (countAll.get() as { n: number } | undefined)?.n ?? 0;
  const todayCount = (countQ.get({ $from: todayStart }) as { n: number } | undefined)?.n ?? 0;
  const weekCount = (countQ.get({ $from: weekStart }) as { n: number } | undefined)?.n ?? 0;
  const monthCount = (countQ.get({ $from: monthStart }) as { n: number } | undefined)?.n ?? 0;

  const timeQ = db.prepare(`
    SELECT COALESCE(SUM(t.duration), 0) as secs
    FROM listening_history lh
    JOIN tracks t ON t.id = lh.track_id
    WHERE lh.action IN ('play', 'complete') AND lh.played_at >= $from
  `);
  const timeAll = db.prepare(`
    SELECT COALESCE(SUM(t.duration), 0) as secs
    FROM listening_history lh
    JOIN tracks t ON t.id = lh.track_id
    WHERE lh.action IN ('play', 'complete')
  `);

  const totalSecs = (timeAll.get() as { secs: number | null } | undefined)?.secs ?? 0;
  const todaySecs = (timeQ.get({ $from: todayStart }) as { secs: number | null } | undefined)?.secs ?? 0;
  const weekSecs = (timeQ.get({ $from: weekStart }) as { secs: number | null } | undefined)?.secs ?? 0;
  const monthSecs = (timeQ.get({ $from: monthStart }) as { secs: number | null } | undefined)?.secs ?? 0;

  // Streak: consecutive days with at least one play
  const dailyDates = db.prepare(`
    SELECT DISTINCT date(played_at, 'unixepoch') as day
    FROM listening_history
    WHERE action IN ('play', 'complete')
    ORDER BY day DESC
  `).all() as { day: string }[];

  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < dailyDates.length; i++) {
    const expected = new Date(today);
    expected.setDate(expected.getDate() - i);
    const expectedStr = expected.toISOString().slice(0, 10);
    if (dailyDates[i]?.day === expectedStr) streak++;
    else break;
  }

  const topTrack = db.prepare(`
    SELECT lh.track_id, t.title, t.artist, COUNT(*) as play_count
    FROM listening_history lh
    JOIN tracks t ON t.id = lh.track_id
    WHERE lh.action IN ('play', 'complete')
    GROUP BY lh.track_id
    ORDER BY play_count DESC
    LIMIT 1
  `).get() as { track_id: string; title: string; artist: string; play_count: number } | undefined;

  const topArtist = db.prepare(`
    SELECT t.artist, COUNT(*) as play_count
    FROM listening_history lh
    JOIN tracks t ON t.id = lh.track_id
    WHERE lh.action IN ('play', 'complete')
    GROUP BY t.artist
    ORDER BY play_count DESC
    LIMIT 1
  `).get() as { artist: string; play_count: number } | undefined;

  return c.json({
    listens: { today: todayCount, week: weekCount, month: monthCount, allTime: totalCount },
    listeningTime: { todaySecs, weekSecs, monthSecs, allTimeSecs: totalSecs },
    streak,
    topTrack: topTrack ?? null,
    topArtist: topArtist ?? null,
  });
});

// ─── Top Tracks ───────────────────────────────────────────────────────────────

router.get("/top-tracks", (c) => {
  const db = getDb();
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 20)), 50);
  const period = validatePeriod(c.req.query("period"));
  const cutoff = periodCutoff(period);

  const rows = cutoff != null
    ? db.prepare(`
        SELECT lh.track_id, t.title, t.artist, t.album, t.cover_url, t.duration, COUNT(*) as play_count
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete') AND lh.played_at >= $from
        GROUP BY lh.track_id
        ORDER BY play_count DESC
        LIMIT $limit
      `).all({ $from: cutoff, $limit: limit })
    : db.prepare(`
        SELECT lh.track_id, t.title, t.artist, t.album, t.cover_url, t.duration, COUNT(*) as play_count
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete')
        GROUP BY lh.track_id
        ORDER BY play_count DESC
        LIMIT $limit
      `).all({ $limit: limit });

  return c.json({ tracks: rows });
});

// ─── Top Artists ──────────────────────────────────────────────────────────────

router.get("/top-artists", (c) => {
  const db = getDb();
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 10)), 50);
  const period = validatePeriod(c.req.query("period"));
  const cutoff = periodCutoff(period);

  const rows = cutoff != null
    ? db.prepare(`
        SELECT t.artist, COUNT(*) as play_count, COUNT(DISTINCT lh.track_id) as unique_tracks,
               MAX(t.cover_url) as cover_url
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete') AND lh.played_at >= $from
        GROUP BY t.artist
        ORDER BY play_count DESC
        LIMIT $limit
      `).all({ $from: cutoff, $limit: limit })
    : db.prepare(`
        SELECT t.artist, COUNT(*) as play_count, COUNT(DISTINCT lh.track_id) as unique_tracks,
               MAX(t.cover_url) as cover_url
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete')
        GROUP BY t.artist
        ORDER BY play_count DESC
        LIMIT $limit
      `).all({ $limit: limit });

  return c.json({ artists: rows });
});

// ─── Top Albums ───────────────────────────────────────────────────────────────

router.get("/top-albums", (c) => {
  const db = getDb();
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 10)), 50);
  const period = validatePeriod(c.req.query("period"));
  const cutoff = periodCutoff(period);

  const rows = cutoff != null
    ? db.prepare(`
        SELECT t.album, t.artist, COUNT(*) as play_count, MAX(t.cover_url) as cover_url
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete') AND t.album IS NOT NULL AND lh.played_at >= $from
        GROUP BY t.album, t.artist
        ORDER BY play_count DESC
        LIMIT $limit
      `).all({ $from: cutoff, $limit: limit })
    : db.prepare(`
        SELECT t.album, t.artist, COUNT(*) as play_count, MAX(t.cover_url) as cover_url
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete') AND t.album IS NOT NULL
        GROUP BY t.album, t.artist
        ORDER BY play_count DESC
        LIMIT $limit
      `).all({ $limit: limit });

  return c.json({ albums: rows });
});

// ─── Heatmap ──────────────────────────────────────────────────────────────────

router.get("/heatmap", (c) => {
  const db = getDb();
  const period = validatePeriod(c.req.query("period") ?? "month");
  const cutoff = periodCutoff(period);

  const rows = cutoff != null
    ? db.prepare(`
        SELECT CAST(strftime('%H', played_at, 'unixepoch') AS INTEGER) as hour,
               COUNT(*) as play_count
        FROM listening_history
        WHERE action IN ('play', 'complete') AND played_at >= $from
        GROUP BY hour
        ORDER BY hour ASC
      `).all({ $from: cutoff })
    : db.prepare(`
        SELECT CAST(strftime('%H', played_at, 'unixepoch') AS INTEGER) as hour,
               COUNT(*) as play_count
        FROM listening_history
        WHERE action IN ('play', 'complete')
        GROUP BY hour
        ORDER BY hour ASC
      `).all();

  const heatmap: { hour: number; play_count: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const found = (rows as { hour: number; play_count: number }[]).find((r) => r.hour === h);
    heatmap.push({ hour: h, play_count: found?.play_count ?? 0 });
  }

  return c.json({ heatmap });
});

// ─── Monthly breakdown ────────────────────────────────────────────────────────

router.get("/monthly", (c) => {
  const db = getDb();
  const monthStart = startOfMonthUnix();

  const rows = db.prepare(`
    SELECT date(played_at, 'unixepoch') as day, COUNT(*) as play_count
    FROM listening_history
    WHERE action IN ('play', 'complete') AND played_at >= $from
    GROUP BY day
    ORDER BY day ASC
  `).all({ $from: monthStart });

  return c.json({ days: rows });
});

// ─── Genre distribution ───────────────────────────────────────────────────────

router.get("/genres", (c) => {
  const db = getDb();
  const period = validatePeriod(c.req.query("period"));
  const cutoff = periodCutoff(period);

  const rows = cutoff != null
    ? db.prepare(`
        SELECT COALESCE(t.genre, 'Unknown') as genre, COUNT(*) as play_count
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete') AND lh.played_at >= $from
        GROUP BY genre
        ORDER BY play_count DESC
        LIMIT 8
      `).all({ $from: cutoff })
    : db.prepare(`
        SELECT COALESCE(t.genre, 'Unknown') as genre, COUNT(*) as play_count
        FROM listening_history lh
        JOIN tracks t ON t.id = lh.track_id
        WHERE lh.action IN ('play', 'complete')
        GROUP BY genre
        ORDER BY play_count DESC
        LIMIT 8
      `).all();

  const typed = rows as { genre: string; play_count: number }[];
  const total = typed.reduce((s, r) => s + r.play_count, 0);
  const genres = typed.map((r) => ({
    ...r,
    percentage: total > 0 ? Math.round((r.play_count / total) * 100) : 0,
  }));

  return c.json({ genres });
});

export default router;
