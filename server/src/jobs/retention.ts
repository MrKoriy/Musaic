import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import { log } from "../logger.js";

export interface RetentionResult {
  archived: number;
  archivePath: string | null;
}

/** Archive and remove listening events older than the configured retention window. */
export function runRetentionJob(retentionDays = 365): RetentionResult {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 365;
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(days * 86400);
  const db = getDb();
  db.prepare(`
    DELETE FROM listening_history
    WHERE id IN (
      SELECT lh.id FROM listening_history lh
      JOIN retention_archive_events ra ON ra.event_id = lh.id
      WHERE lh.played_at < $cutoff
    )
  `).run({ $cutoff: cutoff });
  const firstRow = db.prepare("SELECT id FROM listening_history WHERE played_at < $cutoff ORDER BY id ASC LIMIT 1")
    .get({ $cutoff: cutoff }) as { id: number } | null;
  if (!firstRow) {
    log.info("jobs", "retention found no listening events to archive");
    return { archived: 0, archivePath: null };
  }

  const archiveDir = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const archivePath = path.join(archiveDir, `history-${date}.jsonl`);
  let archived = 0;
  let lastId = 0;
  while (true) {
    const rows = db.prepare(`
      SELECT lh.* FROM listening_history lh
      LEFT JOIN retention_archive_events ra ON ra.event_id = lh.id
      WHERE lh.played_at < $cutoff AND lh.id > $lastId AND ra.event_id IS NULL
      ORDER BY id ASC LIMIT 500
    `).all({ $cutoff: cutoff, $lastId: lastId }) as Array<Record<string, unknown> & { id: number }>;
    if (rows.length === 0) break;
    fs.appendFileSync(archivePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const ids = rows.map((row) => row.id);
    db.transaction(() => {
      const placeholders = ids.map((_, index) => `$id${index}`).join(",");
      db.prepare(`INSERT OR IGNORE INTO retention_archive_events (event_id) VALUES ${ids.map((_, index) => `($id${index})`).join(",")}`)
        .run(Object.fromEntries(ids.map((id, index) => [`$id${index}`, id])));
      db.prepare(`DELETE FROM listening_history WHERE id IN (${placeholders}) AND played_at < $cutoff`)
        .run({ $cutoff: cutoff, ...Object.fromEntries(ids.map((id, index) => [`$id${index}`, id])) });
    })();
    archived += rows.length;
    lastId = ids[ids.length - 1]!;
    if (rows.length < 500) break;
  }
  log.info("jobs", `retention archived and deleted ${archived} listening event(s) to ${archivePath}`);
  return { archived, archivePath };
}
