import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { getLocalProvider } from "../providers/local.js";
import { getYandexProvider } from "../providers/yandex.js";

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
};

export class StreamProxyError extends Error {
  constructor(public readonly status: 400 | 404 | 416 | 502 | 503, message: string) {
    super(message);
  }
}

function localFileResponse(filePath: string, range: string | undefined): Response {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new StreamProxyError(404, "Track file not found");
  }
  if (!stat.isFile()) throw new StreamProxyError(404, "Track file not found");

  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "audio/mpeg";
  const baseHeaders = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (!range) {
    return new Response(createReadStream(filePath) as unknown as ReadableStream, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(stat.size) },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
  }
  const requestedSuffix = match[2] ? Number(match[2]) : 0;
  const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - requestedSuffix);
  let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
  }
  end = Math.min(end, stat.size - 1);
  const length = end - start + 1;
  return new Response(createReadStream(filePath, { start, end }) as unknown as ReadableStream, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": String(length),
    },
  });
}

export function resolveAllowedLocalFile(filePath: string): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const realPath = fs.realpathSync(filePath);
  const roots = [process.env.MUSIC_DIR, process.env.DOWNLOADS_DIR ?? "./downloads"]
    .filter(Boolean)
    .map((root) => {
      try { return fs.realpathSync(path.resolve(root!)); } catch { return null; }
    })
    .filter((root): root is string => Boolean(root));
  return roots.some((root) => realPath === root || realPath.startsWith(`${root}${path.sep}`)) ? realPath : null;
}

async function fetchProviderStream(source: string, trackId: string, bitrate: number, range?: string): Promise<Response> {
  if (source === "yandex") {
    return getYandexProvider().stream(trackId, { bitrate, codec: "mp3" }, range);
  }

  let upstreamUrl: string;
  switch (source) {
    case "vk": {
      const { getVKProvider } = await import("../providers/vk.js");
      upstreamUrl = await getVKProvider().getStreamUrl(trackId);
      break;
    }
    case "soundcloud": {
      const { getSoundCloudProvider } = await import("../providers/soundcloud.js");
      upstreamUrl = await getSoundCloudProvider().getStreamUrl(trackId);
      break;
    }
    case "youtube": {
      const { getYouTubeProvider } = await import("../providers/youtube.js");
      upstreamUrl = await getYouTubeProvider().getStreamUrl(trackId);
      break;
    }
    default:
      throw new StreamProxyError(400, `Unsupported stream source: ${source}`);
  }

  const headers: Record<string, string> = { "User-Agent": "Musaic/1.0" };
  if (range) headers.Range = range;
  return fetch(upstreamUrl, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
}

export async function streamTrack(options: {
  source: string;
  trackId: string;
  bitrate?: number;
  range?: string;
}): Promise<Response> {
  const bitrate = Math.min(320, Math.max(32, Math.floor(options.bitrate ?? 320)));
  if (options.source === "local") {
    const filePath = resolveAllowedLocalFile(getLocalProvider().getFilePath(options.trackId) ?? "");
    if (!filePath) throw new StreamProxyError(404, "Local track file not found");
    return localFileResponse(filePath, options.range);
  }

  const upstream = await fetchProviderStream(options.source, options.trackId, bitrate, options.range);
  if (!upstream.ok || !upstream.body) {
    throw new StreamProxyError(upstream.status >= 500 ? 502 : 503, `Upstream stream failed: ${upstream.status}`);
  }
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, no-store");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "audio/mpeg");
  return new Response(upstream.body, { status: upstream.status, headers });
}
