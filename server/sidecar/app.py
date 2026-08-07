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
  GET  /yandex/station?station=&count=      (header: X-Yandex-Token)
  GET  /yandex/track/<id>                  (header: X-Yandex-Token)
   GET  /yandex/artist?name=&count=         (header: X-Yandex-Token)
   GET  /yandex/likes                         (header: X-Yandex-Token)
  GET  /yandex/download/<id>?codec=&bitrate=   -> raw audio bytes (header: X-Yandex-Token)
  GET  /yandex/validate                    (header: X-Yandex-Token) -> {ok, login}
  GET  /yt/search?q=&count=
  GET  /yt/track/<videoId>
  GET  /yt/artist?name=&count=
  GET  /yt/stream/<videoId>?quality=       -> {url, ...}

Run:  python3 app.py            (reads MUSAIC_SIDECAR_PORT, default 8770)
"""

import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import traceback
import unicodedata
from datetime import datetime, timezone
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
    genre = None
    if track.albums:
        album = track.albums[0].title
        genre = getattr(track.albums[0], "genre", None)
    return {
        "id": f"yandex_{track.id}",
        "source": "yandex",
        "title": (track.title or "").strip() + (f" ({track.version})" if getattr(track, "version", None) else ""),
        "artist": artists.strip(),
        "album": album,
        "genre": str(genre) if genre else None,
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


def yandex_station(token, station, count):
    """Fetch Rotor (notably user:onyourwave) as a candidate track list."""
    client = _get_yandex_client(token)
    station_id = station or "user:onyourwave"
    result = client.rotor_station_tracks(station_id)
    tracks = []
    seen = set()
    for item in (getattr(result, "sequence", None) or []):
        track = getattr(item, "track", None)
        track_id = str(getattr(track, "id", "") or "")
        if not track or not track_id or track_id in seen:
            continue
        seen.add(track_id)
        mapped = _yandex_track_to_dict(track)
        if mapped.get("available", True):
            tracks.append(mapped)
        if len(tracks) >= count:
            break
    return {
        "station": station_id,
        "batchId": getattr(result, "batch_id", None),
        "tracks": tracks,
    }


def yandex_likes(token):
    """Return the user's liked tracks and the best available like timestamps.

    yandex-music has returned both TrackId objects and small wrapper objects
    across releases. Keep the extraction deliberately defensive so a single
    unavailable/deleted item cannot abort a complete import.
    """
    client = _get_yandex_client(token)
    liked_items = client.users_likes_tracks() or []
    ids = []
    timestamps = {}
    for item in liked_items:
        track_id = getattr(item, "id", None)
        if track_id is None and isinstance(item, dict):
            track_id = item.get("id") or item.get("track_id")
        if not track_id:
            continue
        raw_id = str(track_id)
        request_id = str(getattr(item, "track_id", raw_id))
        if request_id not in ids:
            ids.append(request_id)
        timestamp = getattr(item, "timestamp", None)
        if timestamp is None and isinstance(item, dict):
            timestamp = item.get("timestamp") or item.get("liked_at")
        try:
            if timestamp is not None:
                # TrackShort currently exposes an ISO timestamp; older clients
                # exposed Unix seconds/milliseconds.
                if isinstance(timestamp, str) and not timestamp.strip().isdigit():
                    value = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    if value.tzinfo is None:
                        value = value.replace(tzinfo=timezone.utc)
                    timestamps[raw_id] = int(value.timestamp())
                else:
                    value = float(timestamp)
                    if value > 10_000_000_000:
                        value /= 1000
                    timestamps[raw_id] = int(value)
        except (TypeError, ValueError, OverflowError):
            pass

    tracks = []
    for start in range(0, len(ids), 50):
        try:
            for track in client.tracks(ids[start:start + 50]) or []:
                tracks.append(_yandex_track_to_dict(track))
        except Exception:
            # Retry individual ids to preserve the rest of a large import.
            for track_id in ids[start:start + 50]:
                try:
                    one = client.tracks([track_id]) or []
                    if one:
                        tracks.append(_yandex_track_to_dict(one[0]))
                except Exception:
                    continue
    return {"tracks": tracks, "likedAt": timestamps, "total": len(ids)}


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


def audio_embedding(file_path):
    """Build a small deterministic audio fingerprint for local audio.

    This intentionally uses ffmpeg rather than importing Essentia at server
    startup. It keeps the optional feature deployable on small VPS machines;
    projects that already have Essentia can replace this function without
    changing the HTTP contract. The vector is an energy/zero-crossing
    fingerprint, not a semantic model, so it is only an exploration signal.
    """
    raw_path = os.path.abspath(file_path or "")
    roots = [os.environ.get("MUSIC_DIR", ""), os.environ.get("AUDIO_EMBEDDING_ROOT", "")]
    roots = [os.path.abspath(root) for root in roots if root]
    if not roots or not any(raw_path == root or raw_path.startswith(root + os.sep) for root in roots):
        raise ValueError("audio path is outside the configured music roots")
    if not os.path.isfile(raw_path):
        raise LookupError("audio file not found")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for optional audio embeddings")
    result = subprocess.run(
        [ffmpeg, "-v", "error", "-i", raw_path, "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45, check=False,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError("could not decode audio")
    samples = struct.unpack("<%dh" % (len(result.stdout) // 2), result.stdout)
    # Compare 128 equally spaced windows, each represented by RMS, peak and
    # zero-crossing density. Log scaling reduces the effect of loud masters.
    windows = 128
    step = max(1, len(samples) // windows)
    vector = []
    for index in range(windows):
        chunk = samples[index * step:min(len(samples), (index + 1) * step)]
        if not chunk:
            chunk = (0,)
        energy = math.sqrt(sum(float(sample) * sample for sample in chunk) / len(chunk)) / 32768.0
        peak = max(abs(sample) for sample in chunk) / 32768.0
        crossings = sum(1 for left, right in zip(chunk, chunk[1:]) if (left < 0) != (right < 0)) / max(1, len(chunk) - 1)
        vector.append(math.log1p(energy * 100) / math.log(101))
        vector.append(min(1.0, peak))
        vector.append(min(1.0, crossings * 4))
    # Keep the contract compact and stable at 128 dimensions.
    if len(vector) >= 128:
        vector = vector[:128]
    else:
        vector.extend([0.0] * (128 - len(vector)))
    return {"dimensions": 128, "vector": vector}


def yandex_playlist(token, identifier):
    client = _get_yandex_client(token) if token else None
    if not client:
        from yandex_music import Client
        client = Client()
        client.init()

    p = None
    if ":" in identifier:
        owner, kind = identifier.split(":", 1)
        p = client.users_playlists(kind, owner)
    else:
        p = client.playlist(identifier)

    if not p:
        raise LookupError(f"Yandex playlist not found: {identifier}")

    title = getattr(p, "title", "Yandex Playlist")
    tracks = []
    raw_tracks = p.tracks if hasattr(p, "tracks") and p.tracks else p.fetch_tracks()
    for t_item in (raw_tracks or []):
        t = getattr(t_item, "track", t_item)
        if not t:
            continue
        try:
            artists_str = ", ".join(a.name for a in t.artists if getattr(a, "name", None))
            album_str = t.albums[0].title if t.albums and getattr(t.albums[0], "title", None) else None
            cover = f"https://{t.albums[0].cover_uri.replace('%%', '200x200')}" if t.albums and getattr(t.albums[0], "cover_uri", None) else None
            dur_sec = round(t.duration_ms / 1000) if getattr(t, "duration_ms", None) else None
            tracks.append({
                "title": t.title,
                "artist": artists_str,
                "album": album_str,
                "durationSec": dur_sec,
                "coverUrl": cover,
            })
        except Exception:
            continue
    return {"title": title, "tracks": tracks}


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


def _yt_artist_song_to_dict(item):
    """Map a song entry from get_artist()["songs"]["results"]. Depending on the
    ytmusicapi version these carry either "artists" (list of dicts, same as
    search results) or "artist" (plain string); album likewise dict or str."""
    vid = item.get("videoId")
    if not vid:
        return None
    artist = item.get("artist")
    if not artist and item.get("artists"):
        artist = ", ".join(a.get("name", "") for a in item["artists"] if isinstance(a, dict) and a.get("name"))
    elif isinstance(artist, list):
        artist = ", ".join(a.get("name", "") for a in artist if isinstance(a, dict) and a.get("name"))
    album = item.get("album")
    if isinstance(album, dict):
        album = album.get("name")
    dur = item.get("duration_seconds")
    if dur is None and item.get("duration"):
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
        "artist": (artist or "").strip(),
        "album": album,
        "duration": int(dur or 0),
        "coverUrl": _yt_thumb(item.get("thumbnails")),
    }


# Tokens that carry no discriminating power when matching artist names.
_ARTIST_STOP_TOKENS = {"the", "a", "an", "of", "and", "feat", "ft", "dj", "mc", "band", "official"}


def _normalise_artist_text(value):
    decomposed = unicodedata.normalize("NFKD", str(value or ""))
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"[^\w]+", " ", plain.lower(), flags=re.UNICODE).strip()


def _artist_credits(value):
    parts = re.split(
        r"\s*(?:,|;|/|\||\+|&|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b|\bx\b|\band\b)\s*",
        str(value or ""),
        flags=re.IGNORECASE | re.UNICODE,
    )
    return {credit for credit in (_normalise_artist_text(part) for part in parts) if credit}


def _artist_tokens(value):
    tokens = _normalise_artist_text(value).split()
    return {
        t for t in tokens
        if t and t not in _ARTIST_STOP_TOKENS and (len(t) >= 3 or (t.isdigit() and len(t) >= 2))
    }


def _artist_match_score(query, artist, allow_partial=True):
    q = _normalise_artist_text(query)
    a = _normalise_artist_text(artist)
    if not q or not a:
        return -1
    if q == a:
        return 100
    if _artist_credits(query) & _artist_credits(artist):
        return 95
    q_tokens, a_tokens = _artist_tokens(q), _artist_tokens(a)
    if not q_tokens or not a_tokens:
        return -1
    if len(q_tokens) >= 2 and q_tokens <= a_tokens:
        return 85
    if len(q_tokens) == 1 and len(a_tokens) == 1 and q_tokens <= a_tokens:
        return 90
    if allow_partial and len(q_tokens) == 1 and q_tokens <= a_tokens:
        return 60
    return -1


def _artist_matches(query, artist):
    return _artist_match_score(query, artist, allow_partial=True) >= 0


def _artist_credit_matches(query, artist):
    return _artist_match_score(query, artist, allow_partial=False) >= 0


def _pick_artist_match(results, name):
    """Pick the closest named channel instead of the first substring hit."""
    matches = []
    for position, hit in enumerate(results or []):
        if not hit.get("browseId"):
            continue
        score = _artist_match_score(name, hit.get("artist") or hit.get("name") or "", allow_partial=True)
        if score >= 0:
            matches.append((score, -position, hit))
    return max(matches, key=lambda item: (item[0], item[1]))[2] if matches else None


def _yt_item_artist_ids(item):
    values = item.get("artists") or item.get("artist") or []
    if not isinstance(values, list):
        values = [values]
    ids = set()
    for value in values:
        if not isinstance(value, dict):
            continue
        artist_id = value.get("id") or value.get("browseId")
        if artist_id:
            ids.add(str(artist_id))
    return ids


def _yt_item_artist_name(item):
    values = item.get("artists") or item.get("artist") or []
    if not isinstance(values, list):
        values = [values]
    names = []
    for value in values:
        if isinstance(value, dict) and (value.get("name") or value.get("artist")):
            names.append(value.get("name") or value.get("artist"))
        elif isinstance(value, str):
            names.append(value)
    return ", ".join(names)


def _yt_item_belongs_to_artist(item, browse_id, artist_name):
    artist_ids = _yt_item_artist_ids(item)
    if browse_id and artist_ids:
        return str(browse_id) in artist_ids
    return _artist_credit_matches(artist_name, _yt_item_artist_name(item))


def yt_artist(name, count):
    """Artist page tracks: resolve the artist channel first, then take THEIR
    top songs. A plain song search (previous behaviour) returns whatever YT's
    relevance likes — e.g. "FORTUNA 812" surfaced unrelated "Amazwi" tracks."""
    yt = _get_ytmusic()
    tracks = []

    artist_hit = None
    try:
        artist_hit = _pick_artist_match(yt.search(name, filter="artists", limit=5) or [], name)
    except Exception:
        artist_hit = None

    if artist_hit:
        try:
            artist_browse_id = artist_hit["browseId"]
            info = yt.get_artist(artist_browse_id) or {}
            songs_section = info.get("songs") or {}
            for item in songs_section.get("results") or []:
                if not _yt_item_belongs_to_artist(item, artist_browse_id, name):
                    continue
                d = _yt_artist_song_to_dict(item)
                if d:
                    tracks.append(d)
            # The artist page shows ~5 top songs; the full list lives in a
            # linked playlist ("songs" browseId).
            songs_browse = songs_section.get("browseId")
            if songs_browse and len(tracks) < count:
                try:
                    playlist = yt.get_playlist(songs_browse, limit=min(100, max(count, 20))) or {}
                    for item in playlist.get("tracks") or []:
                        if not _yt_item_belongs_to_artist(item, artist_browse_id, name):
                            continue
                        d = _yt_song_to_dict(item)
                        if d:
                            tracks.append(d)
                except Exception:
                    pass
        except Exception:
            tracks = []

    if not tracks:
        # Fallback: plain song search, but keep only tracks actually performed
        # by the requested artist (still better than an empty card).
        results = yt.search(name, filter="songs", limit=count)
        for item in results[:count]:
            d = _yt_song_to_dict(item)
            if d and _artist_credit_matches(name, d["artist"]):
                tracks.append(d)

    # Dedupe by video id, preserving order.
    seen, unique = set(), []
    for t in tracks:
        if t["id"] in seen:
            continue
        seen.add(t["id"])
        unique.append(t)
    return {"tracks": unique[:count]}


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
            if path == "/audio/embedding":
                return self._json(200, audio_embedding(q1("path", "")))
            if path == "/yandex/playlist":
                return self._json(200, yandex_playlist(token, q1("id", "")))
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
            if path == "/yandex/station":
                count = max(1, min(int(q1("count", "50")), 100))
                return self._json(200, yandex_station(token, q1("station", "user:onyourwave"), count))
            if path == "/yandex/likes":
                return self._json(200, yandex_likes(token))
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
