#!/usr/bin/env python3
"""
Musaic media sidecar.

A tiny localhost HTTP service that isolates the brittle, reverse-engineered
music libraries (Yandex Music, YouTube Music, yt-dlp) from the Bun/Hono server.
The Bun server calls this over 127.0.0.1; nothing here is exposed publicly.

Why a sidecar:
  - The maintained clients for Yandex (MarshalX/yandex-music) and YouTube
    (ytmusicapi + yt-dlp) are Python-only and move fast. Keeping them here means
    the TypeScript server never has to track their churn.
  - All Yandex network egress happens in THIS process, so a single optional
    proxy (YANDEX_PROXY) covers both the API calls and the audio download —
    important because Yandex Music only serves Russian IPs.

Endpoints (all JSON unless noted):
  GET  /health
  GET  /yandex/search?q=&count=            (header: X-Yandex-Token)
  GET  /yandex/track/<id>                  (header: X-Yandex-Token)
  GET  /yandex/artist?name=&count=         (header: X-Yandex-Token)
  GET  /yandex/download/<id>?codec=&bitrate=   -> raw audio bytes (header: X-Yandex-Token)
  GET  /yandex/validate                    (header: X-Yandex-Token) -> {ok, login}
  GET  /yt/search?q=&count=
  GET  /yt/track/<videoId>
  GET  /yt/artist?name=&count=
  GET  /yt/stream/<videoId>?quality=       -> {url, ...}

Run:  python3 app.py            (reads MUSAIC_SIDECAR_PORT, default 8770)
"""

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

PORT = int(os.environ.get("MUSAIC_SIDECAR_PORT", "8770"))
HOST = os.environ.get("MUSAIC_SIDECAR_HOST", "127.0.0.1")
# Optional HTTP(S) proxy for ALL Yandex traffic (API + audio download).
# Leave empty when the server itself runs on a Russian IP.
YANDEX_PROXY = os.environ.get("YANDEX_PROXY", "").strip()
# Optional bgutil PO-token provider base URL for YouTube (e.g. http://127.0.0.1:4416).
YT_POT_BASE_URL = os.environ.get("YT_POT_BASE_URL", "").strip()
# Optional ytmusicapi browser-auth headers file for higher reliability / regional results.
YT_AUTH_FILE = os.environ.get("YT_AUTH_FILE", "").strip()

# ── Lazy, cached library handles ────────────────────────────────────────────
_yandex_clients = {}   # token -> yandex_music.Client
_ytmusic = None


def _import_status():
    status = {"yandex": False, "ytmusicapi": False, "yt_dlp": False}
    try:
        import yandex_music  # noqa: F401
        status["yandex"] = True
    except Exception:
        pass
    try:
        import ytmusicapi  # noqa: F401
        status["ytmusicapi"] = True
    except Exception:
        pass
    try:
        import yt_dlp  # noqa: F401
        status["yt_dlp"] = True
    except Exception:
        pass
    return status


def _get_yandex_client(token):
    if not token:
        raise ValueError("Yandex token required (X-Yandex-Token header)")
    if token in _yandex_clients:
        return _yandex_clients[token]
    from yandex_music import Client
    client = Client(token)
    if YANDEX_PROXY:
        # Best-effort: route this client's requests through the RU proxy.
        # The library's Request wrapper exposes the underlying requests session.
        proxies = {"http": YANDEX_PROXY, "https": YANDEX_PROXY}
        for path in ("request.session", "_request.session"):
            obj = client
            ok = True
            for attr in path.split("."):
                obj = getattr(obj, attr, None)
                if obj is None:
                    ok = False
                    break
            if ok and hasattr(obj, "proxies"):
                try:
                    obj.proxies.update(proxies)
                except Exception:
                    pass
    client.init()
    _yandex_clients[token] = client
    return client


def _get_ytmusic():
    global _ytmusic
    if _ytmusic is not None:
        return _ytmusic
    from ytmusicapi import YTMusic
    if YT_AUTH_FILE and os.path.exists(YT_AUTH_FILE):
        _ytmusic = YTMusic(YT_AUTH_FILE)
    else:
        _ytmusic = YTMusic()
    return _ytmusic


# ── Mapping helpers ─────────────────────────────────────────────────────────
def _yandex_cover(uri, size="400x400"):
    if not uri:
        return None
    return "https://" + uri.replace("%%", size)


def _yandex_track_to_dict(track):
    artists = ", ".join(a.name for a in (track.artists or []) if a and a.name)
    album = None
    if track.albums:
        album = track.albums[0].title
    return {
        "id": f"yandex_{track.id}",
        "source": "yandex",
        "title": (track.title or "").strip() + (f" ({track.version})" if getattr(track, "version", None) else ""),
        "artist": artists.strip(),
        "album": album,
        "duration": int((track.duration_ms or 0) / 1000),
        "coverUrl": _yandex_cover(getattr(track, "cover_uri", None)),
        "available": bool(getattr(track, "available", True)),
    }


def _yt_thumb(thumbnails):
    if not thumbnails:
        return None
    # ytmusicapi returns ascending sizes; take the largest.
    return thumbnails[-1].get("url")


def _yt_song_to_dict(item):
    vid = item.get("videoId")
    if not vid:
        return None
    artists = ", ".join(a.get("name", "") for a in (item.get("artists") or []) if a.get("name"))
    album = (item.get("album") or {}).get("name") if isinstance(item.get("album"), dict) else None
    dur = item.get("duration_seconds")
    if dur is None and item.get("duration"):
        # "3:21" -> seconds
        try:
            parts = [int(p) for p in str(item["duration"]).split(":")]
            dur = 0
            for p in parts:
                dur = dur * 60 + p
        except Exception:
            dur = 0
    return {
        "id": f"yt_{vid}",
        "source": "youtube",
        "title": (item.get("title") or "").strip(),
        "artist": artists.strip(),
        "album": album,
        "duration": int(dur or 0),
        "coverUrl": _yt_thumb(item.get("thumbnails")),
    }


# ── Yandex operations ───────────────────────────────────────────────────────
def yandex_search(token, q, count, page=0):
    client = _get_yandex_client(token)
    result = client.search(q, nocorrect=False, page=page)
    tracks = []
    if result and result.tracks and result.tracks.results:
        for t in result.tracks.results[:count]:
            try:
                tracks.append(_yandex_track_to_dict(t))
            except Exception:
                continue
    return {"tracks": tracks}


def yandex_track(token, track_id):
    client = _get_yandex_client(token)
    tracks = client.tracks([track_id])
    if not tracks:
        raise LookupError(f"Yandex track not found: {track_id}")
    return _yandex_track_to_dict(tracks[0])


def yandex_artist(token, name, count):
    client = _get_yandex_client(token)
    result = client.search(name, type_="artist", nocorrect=False)
    tracks = []
    artist = None
    if result and result.artists and result.artists.results:
        artist = result.artists.results[0]
    if artist is not None:
        try:
            brief = client.artists_brief_info(artist.id)
            popular = getattr(brief, "popular_tracks", None) or []
            for t in popular[:count]:
                tracks.append(_yandex_track_to_dict(t))
        except Exception:
            pass
    if not tracks:
        # Fall back to a plain track search performer-style.
        res = client.search(name, type_="track", nocorrect=False)
        if res and res.tracks and res.tracks.results:
            for t in res.tracks.results[:count]:
                tracks.append(_yandex_track_to_dict(t))
    return {"tracks": tracks}


def yandex_download_bytes(token, track_id, codec, bitrate):
    """Return (bytes, content_type). All Yandex egress (incl. proxy) is here."""
    client = _get_yandex_client(token)
    tracks = client.tracks([track_id])
    if not tracks:
        raise LookupError(f"Yandex track not found: {track_id}")
    track = tracks[0]
    try:
        data = track.download_bytes(codec=codec, bitrate_in_kbps=bitrate)
    except Exception:
        # Fall back to best available variant if the requested one is missing.
        data = track.download_bytes()
    ctype = "audio/aac" if codec == "aac" else "audio/mpeg"
    return data, ctype


def yandex_validate(token):
    client = _get_yandex_client(token)
    status = client.account_status()
    login = None
    plus = False
    try:
        login = status.account.login
        plus = bool(status.plus and status.plus.has_plus)
    except Exception:
        pass
    return {"ok": True, "login": login, "plus": plus}


# ── YouTube operations ──────────────────────────────────────────────────────
def yt_search(q, count):
    yt = _get_ytmusic()
    results = yt.search(q, filter="songs", limit=count)
    tracks = []
    for item in results[:count]:
        d = _yt_song_to_dict(item)
        if d:
            tracks.append(d)
    return {"tracks": tracks}


def yt_track(video_id):
    yt = _get_ytmusic()
    info = yt.get_song(video_id)
    vd = (info or {}).get("videoDetails") or {}
    return {
        "id": f"yt_{video_id}",
        "source": "youtube",
        "title": vd.get("title", "").strip(),
        "artist": vd.get("author", "").strip(),
        "album": None,
        "duration": int(vd.get("lengthSeconds") or 0),
        "coverUrl": _yt_thumb((vd.get("thumbnail") or {}).get("thumbnails")),
    }


def yt_artist(name, count):
    yt = _get_ytmusic()
    results = yt.search(name, filter="songs", limit=count)
    tracks = []
    for item in results[:count]:
        d = _yt_song_to_dict(item)
        if d:
            tracks.append(d)
    return {"tracks": tracks}


def yt_stream_url(video_id, quality):
    """Resolve a playable audio URL via yt-dlp.

    Empirically (2026), the `android` player client still returns direct
    progressive audio WITHOUT a PO token, while web/web_music/mweb/ios hit
    SABR ("format not available") and `tv` is DRM-gated. So we lead with
    `android`. When a bgutil PO-token provider is configured (YT_POT_BASE_URL),
    we add web_music/mweb as fallbacks for tracks android can't serve.
    """
    import yt_dlp

    clients = ["android"]
    extractor_args = {}
    if YT_POT_BASE_URL:
        extractor_args["youtubepot-bgutilhttp"] = {"base_url": [YT_POT_BASE_URL]}
        clients += ["web_music", "mweb"]
    extractor_args["youtube"] = {"player_client": clients}

    ydl_opts = {
        # Prefer audio-only (itag 140/251, available via web_music+PO token);
        # without a PO token the android client only exposes muxed itag 18 (mp4),
        # which still plays — AVPlayer uses its audio track.
        "format": "bestaudio[vcodec=none]/bestaudio/best",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "extractor_args": extractor_args,
    }
    cookiefile = os.environ.get("YT_COOKIES_FILE", "").strip()
    if cookiefile and os.path.exists(cookiefile):
        ydl_opts["cookiefile"] = cookiefile

    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    stream = info.get("url")
    if not stream and info.get("requested_formats"):
        stream = info["requested_formats"][0].get("url")
    if not stream:
        raise LookupError(f"No audio stream resolved for {video_id}")
    return {
        "url": stream,
        "ext": info.get("ext"),
        "abr": info.get("abr"),
        "duration": int(info.get("duration") or 0),
    }


# ── HTTP plumbing ───────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quieter logs
        pass

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "none")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        def q1(name, default=None):
            v = qs.get(name)
            return v[0] if v else default

        token = self.headers.get("X-Yandex-Token", "").strip()

        try:
            if path == "/health":
                return self._json(200, {"ok": True, "deps": _import_status(),
                                        "yandexProxy": bool(YANDEX_PROXY),
                                        "ytPotProvider": bool(YT_POT_BASE_URL)})

            # ── Yandex ──
            if path == "/yandex/validate":
                return self._json(200, yandex_validate(token))
            if path == "/yandex/search":
                count = min(int(q1("count", "30")), 100)
                page = max(int(q1("page", "0")), 0)
                return self._json(200, yandex_search(token, q1("q", ""), count, page))
            if path.startswith("/yandex/track/"):
                tid = unquote(path[len("/yandex/track/"):])
                return self._json(200, yandex_track(token, tid))
            if path == "/yandex/artist":
                count = min(int(q1("count", "50")), 100)
                return self._json(200, yandex_artist(token, q1("name", ""), count))
            if path.startswith("/yandex/download/"):
                tid = unquote(path[len("/yandex/download/"):])
                # Token may arrive via header OR query param so callers can hand
                # AVPlayer/Bun a self-contained localhost URL (localhost only).
                dl_token = token or q1("token", "")
                codec = q1("codec", "mp3")
                bitrate = int(q1("bitrate", "320"))
                data, ctype = yandex_download_bytes(dl_token, tid, codec, bitrate)
                return self._bytes(200, data, ctype)

            # ── YouTube ──
            if path == "/yt/search":
                count = min(int(q1("count", "30")), 100)
                return self._json(200, yt_search(q1("q", ""), count))
            if path.startswith("/yt/track/"):
                vid = unquote(path[len("/yt/track/"):])
                return self._json(200, yt_track(vid))
            if path == "/yt/artist":
                count = min(int(q1("count", "50")), 100)
                return self._json(200, yt_artist(q1("name", ""), count))
            if path.startswith("/yt/stream/"):
                vid = unquote(path[len("/yt/stream/"):])
                return self._json(200, yt_stream_url(vid, q1("quality", "high")))

            return self._json(404, {"error": f"unknown path: {path}"})
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except LookupError as e:
            return self._json(404, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            return self._json(500, {"error": str(e), "type": type(e).__name__})


def main():
    deps = _import_status()
    print(f"[sidecar] starting on http://{HOST}:{PORT}  deps={deps}", flush=True)
    if YANDEX_PROXY:
        print(f"[sidecar] Yandex proxy: {YANDEX_PROXY}", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
