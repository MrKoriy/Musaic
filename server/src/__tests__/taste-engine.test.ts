import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb } from "../db/index.js";
import { buildWeightedProfile, buildDailyMix } from "../providers/taste-engine.js";
import { setupTestDb, teardownTestDb, seedTrack } from "./setup.js";

function seedEvent(trackId: string, action: "play" | "complete" | "skip" | "like" | "dislike" | "pause", playedAt?: number) {
  const db = getDb();
  if (playedAt == null) {
    db.prepare("INSERT INTO listening_history (track_id, action) VALUES ($id, $a)").run({ $id: trackId, $a: action });
  } else {
    db.prepare("INSERT INTO listening_history (track_id, action, played_at) VALUES ($id, $a, $t)")
      .run({ $id: trackId, $a: action, $t: playedAt });
  }
}

describe("taste engine", () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it("pushes chronically skipped artists below played ones", () => {
    const loved = seedTrack({ title: "Loved Song", artist: "Loved Artist" });
    const skipped = seedTrack({ title: "Skipped Song", artist: "Skipped Artist" });

    // Same number of events each, but one artist is always skipped.
    for (let i = 0; i < 5; i++) {
      seedEvent(loved, "complete");
      seedEvent(skipped, "play");
      seedEvent(skipped, "skip");
    }

    const profile = buildWeightedProfile();
    const scores = new Map(profile.topArtists.map((a) => [a.artist, a.score]));

    expect(scores.get("Loved Artist") ?? 0).toBeGreaterThan(0);
    // 5 plays (1.0) + 5 skips (-0.5) = +2.5 net, but well below 5 completes (10).
    expect(scores.get("Loved Artist")!).toBeGreaterThan(scores.get("Skipped Artist") ?? 0);
  });

  it("drops artists with a net-negative score from the profile", () => {
    const hated = seedTrack({ title: "Hated Song", artist: "Hated Artist" });
    for (let i = 0; i < 3; i++) seedEvent(hated, "dislike");

    const profile = buildWeightedProfile();
    expect(profile.topArtists.map((a) => a.artist)).not.toContain("Hated Artist");
  });

  it("daily mix excludes recently skipped tracks", () => {
    const db = getDb();
    const good = seedTrack({ title: "Fresh", artist: "Mixer" });
    const skipped = seedTrack({ title: "Stale", artist: "Mixer" });
    db.prepare("UPDATE tracks SET artist = 'Mixer' WHERE id IN ($a, $b)").run({ $a: good, $b: skipped });

    // Build enough history for a profile to exist, then skip one song today.
    for (let i = 0; i < 3; i++) seedEvent(good, "complete");
    seedEvent(skipped, "skip");

    const profile = buildWeightedProfile();
    const mix = buildDailyMix(profile);
    const ids = mix.map((t) => t.id as string);

    expect(ids).not.toContain(skipped);
  });

  it("daily mix dedupes the same song cached from several sources", () => {
    const db = getDb();
    const localId = seedTrack({ id: "local-one", title: "Same Song", artist: "Deduper", source: "local" });
    db.prepare(`
      INSERT INTO tracks (id, source, title, artist, album, duration)
      VALUES ('yt-one', 'youtube', 'Same Song', 'Deduper', 'Album', 180)
    `).run();

    for (let i = 0; i < 3; i++) seedEvent(localId, "complete");

    const profile = buildWeightedProfile();
    const mix = buildDailyMix(profile);
    const songKeys = mix.map((t) => `${String(t.artist).toLowerCase()}|${String(t.title).toLowerCase()}`);

    expect(new Set(songKeys).size).toBe(songKeys.length);
  });

  it("isolates taste profiles by user", () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('user-a', 'alice', 'x')`).run();
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('user-b', 'bob', 'x')`).run();
    const trackA = seedTrack({ title: "Alice Song", artist: "Alice Artist" });
    const trackB = seedTrack({ title: "Bob Song", artist: "Bob Artist" });
    db.prepare("INSERT INTO listening_history (track_id, action, user_id) VALUES ($id, 'complete', 'user-a')")
      .run({ $id: trackA });
    db.prepare("INSERT INTO listening_history (track_id, action, user_id) VALUES ($id, 'complete', 'user-b')")
      .run({ $id: trackB });

    expect(buildWeightedProfile("user-a").topArtists.map((item) => item.artist)).toEqual(["Alice Artist"]);
    expect(buildWeightedProfile("user-b").topArtists.map((item) => item.artist)).toEqual(["Bob Artist"]);
  });

  it("uses synced likes even before the track has been played", () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('user-a', 'alice', 'x')`).run();
    const liked = seedTrack({ title: "Saved For Later", artist: "Liked Artist" });
    db.prepare("INSERT INTO liked_tracks (user_id, track_id) VALUES ('user-a', $id)").run({ $id: liked });

    const profile = buildWeightedProfile("user-a");
    expect(profile.topArtists.map((item) => item.artist)).toContain("Liked Artist");
    expect(profile.topTracks.map((item) => item.id)).toContain(liked);
  });

  it("treats an early skip as stronger negative feedback than a late skip", () => {
    const db = getDb();
    const early = seedTrack({ title: "Early", artist: "Early Skip" });
    const late = seedTrack({ title: "Late", artist: "Late Skip" });
    db.prepare("INSERT INTO listening_history (track_id, action, played_ratio) VALUES ($id, 'skip', 0.03)")
      .run({ $id: early });
    db.prepare("INSERT INTO listening_history (track_id, action, played_ratio) VALUES ($id, 'skip', 0.85)")
      .run({ $id: late });

    const scores = new Map(buildWeightedProfile().topArtists.map((item) => [item.artist, item.score]));
    expect(scores.has("Early Skip")).toBe(false);
    expect(scores.get("Late Skip") ?? 0).toBeGreaterThan(0);
  });
});
