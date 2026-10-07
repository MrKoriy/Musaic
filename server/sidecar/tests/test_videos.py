"""Tests for the music-video endpoints added to the sidecar.

ytmusicapi / yt_dlp are stubbed in sys.modules so the suite runs without the
real dependencies (and without network access).
"""

import importlib.util
import os
import sys
import types
import unittest

# Load sidecar app.py as a module without requiring its optional deps.
_APP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py")


def _load_app():
    spec = importlib.util.spec_from_file_location("musaic_sidecar_app", _APP_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeYTMusic:
    def __init__(self, results):
        self._results = results

    def search(self, q, filter=None, limit=10):
        assert filter == "videos"
        return self._results[:limit]


class TestSearchVideos(unittest.TestCase):
    def setUp(self):
        self.app = _load_app()

    def _with_ytmusic(self, results):
        fake = types.ModuleType("ytmusicapi")
        fake.YTMusic = lambda *a, **kw: _FakeYTMusic(results)
        sys.modules["ytmusicapi"] = fake
        self.app._ytmusic = None

    def tearDown(self):
        sys.modules.pop("ytmusicapi", None)

    def test_maps_video_items(self):
        self._with_ytmusic([
            {
                "videoId": "fHI8X4OXluQ",
                "title": "The Weeknd - Blinding Lights (Official Video)",
                "artists": [{"name": "The Weeknd"}],
                "duration": "3:22",
                "thumbnails": [{"url": "https://i.ytimg.com/small.jpg"}, {"url": "https://i.ytimg.com/big.jpg"}],
                "views": "1,234,567 views",
            },
            {"videoId": None, "title": "skip me"},
        ])
        out = self.app.yt_search_videos("the weeknd blinding lights", 10)
        self.assertEqual(len(out["videos"]), 1)
        video = out["videos"][0]
        self.assertEqual(video["videoId"], "fHI8X4OXluQ")
        self.assertEqual(video["artist"], "The Weeknd")
        self.assertEqual(video["duration"], 202)
        # Largest thumbnail is last in ytmusicapi's ascending list.
        self.assertEqual(video["thumbnailUrl"], "https://i.ytimg.com/big.jpg")

    def test_duration_seconds_preferred_over_string(self):
        self._with_ytmusic([
            {"videoId": "abc123def45", "title": "x", "artists": [], "duration_seconds": 95, "duration": "9:99"},
        ])
        out = self.app.yt_search_videos("x", 10)
        self.assertEqual(out["videos"][0]["duration"], 95)


class _FakeYoutubeDL:
    """Records the yt-dlp options and returns a canned extract_info."""

    captured_opts = None

    def __init__(self, opts):
        _FakeYoutubeDL.captured_opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def extract_info(self, url, download=False):
        return {"url": "https://rr3---sn.googlevideo.com/videoplayback?expire=1", "ext": "mp4", "duration": 200, "width": 1280, "height": 720}


class TestVideoStreamUrl(unittest.TestCase):
    def setUp(self):
        self.app = _load_app()
        fake = types.ModuleType("yt_dlp")
        fake.YoutubeDL = _FakeYoutubeDL
        sys.modules["yt_dlp"] = fake

    def tearDown(self):
        sys.modules.pop("yt_dlp", None)

    def test_requires_muxed_format(self):
        out = self.app.yt_video_stream_url("abc123def45")
        self.assertEqual(out["url"].split("?")[0], "https://rr3---sn.googlevideo.com/videoplayback")
        self.assertEqual(out["duration"], 200)
        # The format selector must demand BOTH audio and video tracks so the
        # client gets a single directly-playable URL.
        fmt = _FakeYoutubeDL.captured_opts["format"]
        self.assertIn("vcodec!=none", fmt)
        self.assertIn("acodec!=none", fmt)

    def test_missing_url_raises_lookup(self):
        class _Empty(_FakeYoutubeDL):
            def extract_info(self, url, download=False):
                return {}

        fake = types.ModuleType("yt_dlp")
        fake.YoutubeDL = _Empty
        sys.modules["yt_dlp"] = fake
        with self.assertRaises(LookupError):
            self.app.yt_video_stream_url("abc123def45")


if __name__ == "__main__":
    unittest.main()
