import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, createPlaylist, addTrackToPlaylist, removeTrackFromPlaylist, getPlaylistTracks, logListening } from "../db/index.js";
import { playlistsRouter } from "../routes/local/playlists.js";
import statsRouter, { localMidnight, validTimezone } from "../routes/stats.js";
import { LocalFLACProvider } from "../providers/local.js";
import { runRetentionJob } from "../jobs/retention.js";
import { SearchPager } from "../utils/search-pager.js";
import type { Track } from "../types.js";
import { recommendationSignals } from "../reco/persistence.js";
import { RECO_FEATURE_NAMES } from "../reco/ranker.js";
import { seedTrack, setupTestDb, teardownTestDb } from "./setup.js";
function app() { const a = new Hono(); a.route("/playlists", playlistsRouter); a.route("/stats", statsRouter); return a; }
const track = (id: string, source: Track["source"] = "local"): Track => ({ id, source, title: id, artist: "Audit", duration: 180 });

describe("audit regressions", () => {
  beforeEach(setupTestDb);
  afterEach(() => { setSystemTime(); teardownTestDb(); });
  it("searches local tracks and treats punctuation as text", async () => {
    seedTrack({ id: "acdc", title: "Back in Black", artist: "AC/DC" });
    const p = new LocalFLACProvider("/unused");
    expect((await p.search("AC/DC", 20)).map(t => t.id)).toEqual(["acdc"]);
    expect((await p.search('Back "in"', 20)).map(t => t.id)).toEqual(["acdc"]);
    expect(await p.search("///", 20)).toEqual([]);
  });
  it("changes ETags even when timestamps are equal", async () => {
    createPlaylist("p", "Playlist"); ["a", "b"].forEach(id => seedTrack({ id })); addTrackToPlaylist("p", "a");
    getDb().query("UPDATE playlists SET updated_at = 123 WHERE id = 'p'").run();
    const first = await app().request("/playlists/p/tracks"); addTrackToPlaylist("p", "b");
    getDb().query("UPDATE playlists SET updated_at = 123 WHERE id = 'p'").run();
    const next = await app().request("/playlists/p/tracks", { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect(next.status).toBe(200); expect(next.headers.get("etag")).not.toBe(first.headers.get("etag"));
  });
  it("invalidates validators when track metadata changes", async () => {
    createPlaylist("p", "Playlist"); addTrackToPlaylist("p", seedTrack({ id: "a" }));
    const first = await app().request("/playlists/p/tracks"); getDb().query("UPDATE tracks SET title = 'Changed' WHERE id = 'a'").run();
    expect((await app().request("/playlists/p/tracks", { headers: { "If-None-Match": first.headers.get("etag")! } })).status).toBe(200);
  });
  it("appends after holes and handles explicit insertions without duplicates", async () => {
    createPlaylist("p", "Playlist"); ["a", "b", "c", "d"].forEach(id => seedTrack({ id }));
    ["a", "b", "c"].forEach(id => addTrackToPlaylist("p", id)); removeTrackFromPlaylist("p", "a"); addTrackToPlaylist("p", "d");
    const rows = getDb().query("SELECT position FROM playlist_tracks WHERE playlist_id = 'p' ORDER BY position").all() as Array<{ position: number }>;
    expect(rows.map(r => r.position)).toEqual([1, 2, 3]); expect(getPlaylistTracks("p").map(t => t.id)).toEqual(["b", "c", "d"]);
    addTrackToPlaylist("p", "a", 2); addTrackToPlaylist("p", "a", 0);
    expect(getPlaylistTracks("p").map(t => t.id)).toEqual(["b", "a", "c", "d"]);
  });
  it("paginates without loss and rejects changed revisions", async () => {
    createPlaylist("p", "Playlist"); ["a", "b", "c"].forEach(id => { seedTrack({ id }); addTrackToPlaylist("p", id); });
    const first = await (await app().request("/playlists/p/tracks?limit=2")).json() as any;
    expect(first.tracks.map((t: any) => t.id)).toEqual(["a", "b"]);
    const second = await (await app().request(`/playlists/p/tracks?limit=2&cursor=${first.nextCursor}`)).json() as any;
    expect(second.tracks.map((t: any) => t.id)).toEqual(["c"]); expect(second.hasMore).toBe(false);
    removeTrackFromPlaylist("p", "a"); expect((await app().request(`/playlists/p/tracks?limit=2&cursor=${first.nextCursor}`)).status).toBe(409);
    expect((await app().request("/playlists/p/tracks?limit=abc")).status).toBe(400);
  });
  it("uses the requested timezone for days, streaks and heatmap", async () => {
    setSystemTime(new Date("2026-10-07T13:00:00Z")); const id = seedTrack();
    logListening(id, "complete", null, { eventId: "tz1", playedAt: Date.parse("2026-10-06T22:00:00Z") / 1000, playedMs: 180_000, durationMs: 180_000 });
    const data = await (await app().request("/stats/overview?timezone=Europe%2FMoscow")).json() as any;
    expect(data.streak).toBe(1); expect(data.listens.today).toBe(1);
    const heat = await (await app().request("/stats/heatmap?timezone=Europe%2FMoscow&period=today")).json() as any;
    expect(heat.heatmap[1].play_count).toBe(1); expect(heat.heatmap[22].play_count).toBe(0);
    const month = await (await app().request("/stats/monthly?timezone=Europe%2FMoscow")).json() as any;
    expect(month.days).toEqual([{ day: "2026-10-07", play_count: 1 }]);
  });
  it("handles DST and fractional timezone offsets", () => {
    expect(localMidnight("2026-03-29", "Europe/Berlin")).toBe(Date.parse("2026-03-28T23:00:00Z") / 1000);
    expect(localMidnight("2026-03-30", "Europe/Berlin")).toBe(Date.parse("2026-03-29T22:00:00Z") / 1000);
    expect(localMidnight("2026-10-07", "Asia/Kathmandu")).toBe(Date.parse("2026-10-06T18:15:00Z") / 1000);
    expect(validTimezone("not-a-zone")).toBe("UTC");
  });
  it("preserves lifetime totals after retention and de-duplicates retries", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "musaic-retention-audit-")); const previous = process.env.DOWNLOADS_DIR; process.env.DOWNLOADS_DIR = directory;
    try {
      const id = seedTrack(); const details = { eventId: "old", playedAt: Math.floor(Date.now() / 1000) - 400 * 86400, playedMs: 180_000, durationMs: 180_000 };
      expect(logListening(id, "complete", null, details)).toBe(true); expect(logListening(id, "complete", null, details)).toBe(false); runRetentionJob();
      expect(logListening(id, "complete", null, details)).toBe(false);
      const result = await (await app().request("/stats/overview")).json() as any;
      expect(result.listens.allTime).toBe(1); expect(result.listeningTime.allTimeSecs).toBe(180);
      expect((await (await app().request("/stats/top-tracks")).json() as any).tracks[0].play_count).toBe(1);
    } finally { if (previous == null) delete process.env.DOWNLOADS_DIR; else process.env.DOWNLOADS_DIR = previous; fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("isolates user statistics", async () => {
    getDb().query("INSERT INTO users(id, username, display_name, password_hash) VALUES('other', 'other', 'Other', 'unused')").run();
    const id = seedTrack(); logListening(id, "complete", "other", { eventId: "other", playedMs: 180_000, durationMs: 180_000 });
    expect((await (await app().request("/stats/overview")).json() as any).listens.allTime).toBe(0);
  });
});
describe("search cursor buffering", () => {
  it("returns every result and identical pages on retry", async () => {
    const pager = new SearchPager(); const catalog = { local: Array.from({ length: 5 }, (_, i) => track(`local-${i}`)), soundcloud: Array.from({ length: 5 }, (_, i) => track(`sc-${i}`, "soundcloud")) };
    const fetcher = async (source: string, offset: number, limit: number) => catalog[source as keyof typeof catalog].slice(offset, offset + limit);
    let page = (await pager.page("scope", ["local", "soundcloud"], 2, fetcher))!; const seen = page.tracks.map(t => t.id); const cursor = page.nextCursor!;
    expect(await pager.page("scope", ["local", "soundcloud"], 2, fetcher, cursor)).toEqual(await pager.page("scope", ["local", "soundcloud"], 2, fetcher, cursor));
    while (page.hasMore) { page = (await pager.page("scope", ["local", "soundcloud"], 2, fetcher, page.nextCursor))!; seen.push(...page.tracks.map(t => t.id)); }
    expect(seen).toHaveLength(10); expect(new Set(seen).size).toBe(10); expect(await pager.page("wrong", ["local", "soundcloud"], 2, fetcher, cursor)).toBeNull();
  });
  it("keeps alternative sources for deduplicated families", async () => {
    const page = await new SearchPager().page("scope", ["local", "soundcloud"], 2, async source => [{ ...track(source, source as Track["source"]), title: "Same Song" }]);
    expect(page?.tracks).toHaveLength(1); expect(page?.tracks[0]?.versions).toHaveLength(2); expect(() => JSON.stringify(page)).not.toThrow();
  });
});


describe("recommendation explanations", () => {
  it("exposes only factual positive feature signals", () => {
    const features = RECO_FEATURE_NAMES.map(name => name === "tagOverlap" || name === "moodMatchCount" ? 1 : 0);
    expect(recommendationSignals(features)).toEqual(["shared_tags", "mood_match"]);
    expect(recommendationSignals(undefined)).toEqual([]);
    expect(recommendationSignals(RECO_FEATURE_NAMES.map(() => 0))).toEqual([]);
  });
});
