/** Timezone-aware analytics over retention-independent rollups. */
import { Hono, type Context } from "hono";
import { getDb } from "../db/index.js";

const router = new Hono();
type Period = "today" | "week" | "month" | "alltime";
const periods = new Set<Period>(["today", "week", "month", "alltime"]);

export function validTimezone(raw?: string): string {
  const timezone = raw ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); return timezone; }
  catch { return "UTC"; }
}
function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}
export function calendarParts(epoch: number, timezone: string): Record<string, string> {
  return Object.fromEntries(formatter(timezone).formatToParts(new Date(epoch * 1000)).map(p => [p.type, p.value]));
}
function calendarDay(epoch: number, fmt: Intl.DateTimeFormat): string {
  const p = Object.fromEntries(fmt.formatToParts(new Date(epoch * 1000)).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
/** Resolve local midnight by iterating the offset; handles DST and fractional offsets. */
export function localMidnight(day: string, timezone: string): number {
  const target = Date.parse(`${day}T00:00:00Z`) / 1000;
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const p = calendarParts(guess, timezone);
    const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) / 1000;
    const next = guess + target - wall;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
function scope(c: Context) {
  const uid = (c as any).get("userId") as string | undefined;
  const timezone = validTimezone(c.req.query("timezone"));
  const now = Math.floor(Date.now() / 1000);
  const fmt = formatter(timezone);
  const today = calendarDay(now, fmt);
  const period = periods.has(c.req.query("period") as Period) ? c.req.query("period") as Period : "alltime";
  return { uid: uid ?? "", timezone, now, fmt, today, period };
}
function cutoff(period: Period, today: string, timezone: string): number {
  if (period === "alltime") return 0;
  const day = period === "month" ? `${today.slice(0, 7)}-01` : period === "week" ? shiftDay(today, -6) : today;
  return localMidnight(day, timezone);
}
function boundedLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.floor(n))) : fallback;
}
function aggregateSource(period: Period): { table: string; timeFilter: string } {
  return period === "alltime"
    ? { table: "listening_stats_totals", timeFilter: "" }
    : { table: "listening_stats_minutes", timeFilter: "AND s.bucket >= $from" };
}
function topRows(c: Context, kind: "tracks" | "artists" | "albums" | "genres", overridePeriod?: Period, overrideLimit?: number) {
  const s = scope(c); const period = overridePeriod ?? s.period;
  const { table, timeFilter } = aggregateSource(period);
  const fields = {
    tracks: "s.track_id, t.title, t.artist, t.album, t.cover_url, t.duration",
    artists: "t.artist, COUNT(DISTINCT s.track_id) AS unique_tracks, MAX(t.cover_url) AS cover_url",
    albums: "t.album, t.artist, MAX(t.cover_url) AS cover_url",
    genres: "COALESCE(t.genre, 'Unknown') AS genre",
  };
  const groups = { tracks: "s.track_id", artists: "t.artist", albums: "t.album, t.artist", genres: "COALESCE(t.genre, 'Unknown')" };
  const limit = overrideLimit ?? boundedLimit(c.req.query("limit"), kind === "tracks" ? 20 : 10);
  const params: Record<string, string | number> = { $uid: s.uid, $limit: limit };
  if (timeFilter) params.$from = cutoff(period, s.today, s.timezone);
  return getDb().prepare(`
    SELECT ${fields[kind]}, SUM(s.listens) AS play_count
    FROM ${table} s JOIN tracks t ON t.id = s.track_id
    WHERE s.user_key = $uid ${timeFilter} ${kind === "albums" ? "AND t.album IS NOT NULL" : ""}
    GROUP BY ${groups[kind]} ORDER BY play_count DESC, ${groups[kind]} ASC LIMIT $limit
  `).all(params) as Array<Record<string, any>>;
}

router.get("/overview", c => {
  const s = scope(c); const db = getDb();
  const totals = db.prepare("SELECT COALESCE(SUM(listens), 0) AS listens, COALESCE(SUM(seconds), 0) AS seconds FROM listening_stats_totals WHERE user_key = ?")
    .get(s.uid) as { listens: number; seconds: number };
  const todayStart = cutoff("today", s.today, s.timezone);
  const weekStart = cutoff("week", s.today, s.timezone);
  const monthStart = cutoff("month", s.today, s.timezone);
  const from = localMidnight(shiftDay(s.today, -365), s.timezone);
  // At most one row per occupied UTC minute, rather than scanning play events.
  const rows = db.prepare("SELECT bucket, SUM(listens) AS listens, SUM(seconds) AS seconds FROM listening_stats_minutes WHERE user_key = ? AND bucket >= ? GROUP BY bucket ORDER BY bucket DESC")
    .all(s.uid, from) as Array<{ bucket: number; listens: number; seconds: number }>;
  const listens = { today: 0, week: 0, month: 0, allTime: totals.listens };
  const listeningTime = { todaySecs: 0, weekSecs: 0, monthSecs: 0, allTimeSecs: totals.seconds };
  const days = new Set<string>();
  for (const row of rows) {
    days.add(calendarDay(row.bucket, s.fmt));
    if (row.bucket >= todayStart) { listens.today += row.listens; listeningTime.todaySecs += row.seconds; }
    if (row.bucket >= weekStart) { listens.week += row.listens; listeningTime.weekSecs += row.seconds; }
    if (row.bucket >= monthStart) { listens.month += row.listens; listeningTime.monthSecs += row.seconds; }
  }
  let streak = 0;
  for (let i = 0; i < 365 && days.has(shiftDay(s.today, -i)); i++) streak++;
  return c.json({ listens, listeningTime, streak, topTrack: topRows(c, "tracks", "alltime", 1)[0] ?? null,
    topArtist: topRows(c, "artists", "alltime", 1)[0] ?? null });
});
router.get("/top-tracks", c => c.json({ tracks: topRows(c, "tracks") }));
router.get("/top-artists", c => c.json({ artists: topRows(c, "artists") }));
router.get("/top-albums", c => c.json({ albums: topRows(c, "albums") }));
router.get("/heatmap", c => {
  const s = scope(c); const period = c.req.query("period") ? s.period : "month";
  const rows = getDb().prepare("SELECT bucket, SUM(listens) AS listens FROM listening_stats_minutes WHERE user_key = ? AND bucket >= ? GROUP BY bucket")
    .all(s.uid, cutoff(period, s.today, s.timezone)) as Array<{ bucket: number; listens: number }>;
  const heatmap = Array.from({ length: 24 }, (_, hour) => ({ hour, play_count: 0 }));
  for (const row of rows) {
    const p = Object.fromEntries(s.fmt.formatToParts(new Date(row.bucket * 1000)).map(p => [p.type, p.value]));
    heatmap[Number(p.hour)]!.play_count += row.listens;
  }
  return c.json({ heatmap });
});
router.get("/monthly", c => {
  const s = scope(c);
  const rows = getDb().prepare("SELECT bucket, SUM(listens) AS listens FROM listening_stats_minutes WHERE user_key = ? AND bucket >= ? GROUP BY bucket")
    .all(s.uid, cutoff("month", s.today, s.timezone)) as Array<{ bucket: number; listens: number }>;
  const days = new Map<string, number>();
  for (const row of rows) {
    const day = calendarDay(row.bucket, s.fmt); days.set(day, (days.get(day) ?? 0) + row.listens);
  }
  return c.json({ days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, play_count]) => ({ day, play_count })) });
});
router.get("/genres", c => {
  const rows = topRows(c, "genres", undefined, 8);
  const total = rows.reduce((sum, row) => sum + Number(row.play_count), 0);
  return c.json({ genres: rows.map(row => ({ ...row, percentage: total > 0 ? Math.round(row.play_count / total * 100) : 0 })) });
});
export default router;
