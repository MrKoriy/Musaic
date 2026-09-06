import { getDb } from "../db/index.js";
import { getYandexConfig } from "../db/index.js";
import { sidecarGet } from "../providers/sidecar.js";
import { buildWeightedProfile } from "../reco/profile.js";
import { log } from "../logger.js";

interface SidecarRelease {
  id: string;
  title: string;
  artist: string;
  year?: number | null;
  coverUrl?: string | null;
  trackCount?: number;
}

/**
 * Poll the top artists' Yandex releases and record any that are new to us.
 * New releases are written to `artist_releases` with `notified_at` NULL so the
 * client can surface a "new album" push. Idempotent: a release already seen is
 * never re-inserted.
 */
export async function runReleaseDetectionJob(): Promise<{
  artistsChecked: number;
  newReleases: number;
}> {
  const config = getYandexConfig();
  if (!config.token) return { artistsChecked: 0, newReleases: 0 };

  const profile = buildWeightedProfile(null);
  const topArtists = profile.topArtists
    .slice(0, 12)
    .map((a) => a.artist)
    .filter((name) => name.trim().length > 0);
  if (topArtists.length === 0) return { artistsChecked: 0, newReleases: 0 };

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO artist_releases
      (id, artist, title, year, cover_url, track_count, first_seen_at)
    VALUES ($id, $artist, $title, $year, $cover, $trackCount, unixepoch())
  `);

  let newReleases = 0;
  for (const artist of topArtists) {
    try {
      const { releases } = await sidecarGet<{ releases: SidecarRelease[] }>(
        `/yandex/artist/releases?name=${encodeURIComponent(artist)}&count=20`,
        { "X-Yandex-Token": config.token },
        30_000,
      );
      for (const release of releases ?? []) {
        if (!release.id || !release.title) continue;
        insert.run({
          $id: `yandex_${release.id}`,
          $artist: release.artist ?? artist,
          $title: release.title,
          $year: release.year ?? null,
          $cover: release.coverUrl ?? null,
          $trackCount: release.trackCount ?? null,
        });
        newReleases += 1;
      }
    } catch (error) {
      log.warn("jobs", `release-detection: artist "${artist}" failed:`,
        error instanceof Error ? error.message : String(error));
    }
  }
  return { artistsChecked: topArtists.length, newReleases };
}
