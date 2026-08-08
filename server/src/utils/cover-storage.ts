import fs from "node:fs";
import path from "node:path";

export interface StoredCover {
  data: Buffer;
  mimeType: string;
  relativePath: string;
}

export function coversDirectory(): string {
  return path.resolve(process.env.COVERS_DIR ?? path.join(process.cwd(), "covers"));
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/avif": return "avif";
    default: return "jpg";
  }
}

function safeFileStem(id: string): string {
  const stem = id.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return stem || "cover";
}

export function coverRelativePath(id: string, mimeType: string, playlist = false): string {
  const stem = `${safeFileStem(id)}.${extensionForMime(mimeType)}`;
  return playlist ? path.join("playlists", stem) : stem;
}

function absolutePath(relativePath: string): string | null {
  const root = coversDirectory();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export function writeCoverFile(
  id: string,
  data: Buffer,
  mimeType: string,
  playlist = false,
): string {
  const relativePath = coverRelativePath(id, mimeType, playlist);
  const target = absolutePath(relativePath);
  if (!target) throw new Error("Invalid cover path");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
  return relativePath;
}

export function readCoverFile(relativePath: string | null | undefined): StoredCover | null {
  if (!relativePath) return null;
  const target = absolutePath(relativePath);
  if (!target || !fs.existsSync(target)) return null;
  try {
    return {
      data: fs.readFileSync(target),
      mimeType: mimeTypeForPath(target),
      relativePath,
    };
  } catch {
    return null;
  }
}

function mimeTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    default: return "image/jpeg";
  }
}
