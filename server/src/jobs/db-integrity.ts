import { getDb } from "../db/index.js";
import { log } from "../logger.js";

export interface DbIntegrityResult {
  ok: boolean;
  detail: string | null;
  elapsedMs: number;
}

/**
 * Hourly corruption canary. We have had three "2nd reference to page"
 * incidents; the nightly backup catches them up to 20 hours late. A quick_check
 * takes well under a second on a 20MB database and catches damage while the
 * surrounding events are still fresh.
 */
export function runDbIntegrityJob(): DbIntegrityResult {
  const started = Date.now();
  const row = getDb().prepare("PRAGMA quick_check").all() as Array<{ [key: string]: unknown }>;
  const first = row[0] as { quick_check?: string } | undefined;
  const detail = typeof first?.quick_check === "string" ? first.quick_check : JSON.stringify(first ?? null);
  const ok = detail === "ok";
  const result: DbIntegrityResult = { ok, detail: ok ? null : detail.slice(0, 500), elapsedMs: Date.now() - started };
  if (ok) {
    log.info("jobs", `db integrity: ok (${result.elapsedMs}ms)`);
  } else {
    log.error("jobs", `DB INTEGRITY FAILURE — quick_check reports damage: ${result.detail}`);
  }
  return result;
}
