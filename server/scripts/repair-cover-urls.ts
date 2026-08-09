/**
 * One-off data repair: unwrap nested /api/artwork proxy chains that were
 * accidentally persisted into tracks.cover_url by earlier import cycles.
 *
 * Usage: bun run scripts/repair-cover-urls.ts [DB_PATH]
 */
import { Database } from "bun:sqlite";

const dbPath = process.argv[2] ?? process.env.DB_PATH ?? "musaic.db";
const db = new Database(dbPath);

function normalizeCoverUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let current = value.trim();
  if (current.startsWith("/")) return current;
  for (let depth = 0; depth < 10; depth++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }
    if (!/^\/api\/artwork(?:\/|$)/.test(parsed.pathname)) return current;
    const inner = parsed.searchParams.get("url")?.trim();
    if (!inner) return null;
    current = inner;
  }
  return null;
}

const rows = db
  .query(`SELECT id, cover_url FROM tracks WHERE cover_url LIKE '%/api/artwork%'`)
  .all() as Array<{ id: string; cover_url: string }>;

let fixed = 0;
const update = db.prepare(`UPDATE tracks SET cover_url = $url, updated_at = unixepoch() WHERE id = $id`);
const run = db.transaction((rows: Array<{ id: string; cover_url: string }>) => {
  for (const row of rows) {
    const cleaned = normalizeCoverUrl(row.cover_url);
    if (cleaned !== null && cleaned !== row.cover_url) {
      update.run({ $url: cleaned, $id: row.id });
      fixed++;
    }
  }
});
run(rows);

console.log(`Repaired ${fixed}/${rows.length} cover_url rows in ${dbPath}`);