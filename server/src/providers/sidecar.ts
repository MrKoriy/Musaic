/**
 * Media sidecar client.
 *
 * The Yandex/YouTube providers talk to a small Python service (server/sidecar)
 * that wraps yandex-music, ytmusicapi, and yt-dlp. This module finds it, starts
 * it on demand, and exposes a typed GET helper. Nothing here is exposed beyond
 * 127.0.0.1.
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// src/providers/sidecar.ts -> ../../sidecar
const SIDECAR_DIR = process.env.SIDECAR_DIR
  ? path.resolve(process.env.SIDECAR_DIR)
  : path.resolve(MODULE_DIR, "../../sidecar");

const PORT = Number(process.env.MUSAIC_SIDECAR_PORT ?? 8770);
export const SIDECAR_BASE_URL = (process.env.SIDECAR_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const AUTOSTART = process.env.SIDECAR_AUTOSTART !== "0";

let _spawnPromise: Promise<void> | null = null;
let _spawned = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_BASE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function venvPython(): string | null {
  const candidates = [
    path.join(SIDECAR_DIR, ".venv", "bin", "python"),
    path.join(SIDECAR_DIR, ".venv", "bin", "python3"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function spawnSidecar(): Promise<void> {
  const py = venvPython();
  if (!py) {
    throw new Error(`Sidecar not set up. Run: ${path.join(SIDECAR_DIR, "setup.sh")}`);
  }
  const logPath = path.join(SIDECAR_DIR, "sidecar.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn(py, ["app.py"], {
    cwd: SIDECAR_DIR,
    env: { ...process.env, MUSAIC_SIDECAR_PORT: String(PORT) },
    stdio: ["ignore", out, out],
    detached: false,
  });
  child.on("error", (e) => console.error("[sidecar] spawn error:", e.message));
  _spawned = true;
  console.log(`[sidecar] starting (${py} app.py) → logs: ${logPath}`);
  // Wait up to ~12s for the service to become healthy.
  for (let i = 0; i < 24; i++) {
    if (await isHealthy(1000)) {
      console.log("[sidecar] healthy");
      return;
    }
    await sleep(500);
  }
  throw new Error("Sidecar failed to become healthy within 12s");
}

/** Ensure the sidecar is reachable, spawning it once if needed. */
export async function ensureSidecar(): Promise<void> {
  if (await isHealthy()) return;
  if (!AUTOSTART) throw new Error("Media sidecar not reachable and SIDECAR_AUTOSTART=0");
  if (!_spawnPromise) {
    _spawnPromise = spawnSidecar().catch((e) => {
      _spawnPromise = null; // allow retry on next call
      throw e;
    });
  }
  await _spawnPromise;
}

/** Whether the sidecar dependencies are installed (venv present). */
export function sidecarInstalled(): boolean {
  return venvPython() !== null;
}

/** GET a JSON endpoint on the sidecar, auto-starting it if needed. */
export async function sidecarGet<T>(
  pathAndQuery: string,
  headers: Record<string, string> = {},
  timeoutMs = 25_000
): Promise<T> {
  await ensureSidecar();
  const res = await fetch(`${SIDECAR_BASE_URL}${pathAndQuery}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Sidecar ${pathAndQuery}: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

export interface SidecarTrack {
  id: string;
  source: "yandex" | "youtube";
  title: string;
  artist: string;
  album?: string | null;
  duration: number;
  coverUrl?: string | null;
  available?: boolean;
}
