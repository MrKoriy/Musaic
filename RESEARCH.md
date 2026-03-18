# Musaic — Technical Research (v2)

> Personal music app for 1-2 users. Spotify-like UX with hi-res audio, AI recommendations, AI lyrics, VK Music + SoundCloud integration. Maximum budget optimization.

---

## Table of Contents

1. [Tech Stack (Personal Scale)](#1-tech-stack-personal-scale)
2. [Hi-Res Audio: Local FLAC Library](#2-hi-res-audio-local-flac-library)
3. [Music Sources: VK + SoundCloud + Local](#3-music-sources-vk--soundcloud--local)
4. [AI Music Recommendation](#4-ai-music-recommendation)
5. [AI Lyrics: Parakeet TDT v3](#5-ai-lyrics-parakeet-tdt-v3)
6. [Architecture Overview](#6-architecture-overview)
7. [Development Phases](#7-development-phases)
8. [Cost Estimate](#8-cost-estimate)

---

## 1. Tech Stack (Personal Scale)

### Core Stack

| Layer | Choice | Package | Why |
|-------|--------|---------|-----|
| **Framework** | React Native (Expo SDK 53) | `expo@~53.x` | Single codebase iOS+Android, JSI/Fabric for audio perf |
| **Audio** | react-native-track-player | `react-native-track-player@^4.1` | Background playback, lock screen, queue management |
| **UI/Glass** | Blur + Reanimated | `@react-native-community/blur`, `react-native-reanimated@^3.x` | Glassmorphism effects |
| **Navigation** | React Navigation | `@react-navigation/native@^7.x` | Tab bar + stack + bottom sheet |
| **State** | Zustand | `zustand@^5.0` | Player state, library state, simple and fast |
| **Local DB** | SQLite (expo-sqlite) | `expo-sqlite` | Track metadata, playlists, listening history — no server needed |
| **KV Store** | MMKV | `react-native-mmkv@^3.x` | Settings, cache, tokens |
| **Icons** | Lucide | `lucide-react-native` | Clean outlined icons |
| **Backend** | Bun + Hono (local server) | `bun`, `hono` | Lightweight API for VK/SC proxying + lyrics pipeline |
| **AI Gateway** | OpenRouter | API | Cheapest access to MiniMax, Gemini Flash, etc. |

### What We DON'T Need (Personal Scale)

- ~~Cloudflare R2~~ — no CDN, audio served from local storage or direct from sources
- ~~Supabase~~ — SQLite on device is enough for 1-2 users
- ~~Meilisearch~~ — SQLite FTS5 handles search for personal library
- ~~PostHog / Sentry~~ — no analytics or crash reporting needed
- ~~EAS paid tier~~ — `expo run:ios` / `expo run:android` locally
- ~~pgvector~~ — song similarity via Last.fm API, not embeddings

### Audio Playback

| Feature | Status |
|---------|--------|
| Background playback | Built-in (RNTP) |
| Lock screen controls | Built-in (RNTP) |
| FLAC playback | Built-in (ExoPlayer/AVFoundation) |
| Gapless playback | ExoPlayer handles it (Android); iOS partial |
| Queue management | Built-in (RNTP) |

---

## 2. Hi-Res Audio: Local FLAC Library

### Strategy: Torrent-Sourced FLAC + Local Import

The primary hi-res source is the user's own FLAC library, typically from torrent trackers (RuTracker, RED, etc.) with extensive lossless catalogs.

### How It Works

1. User downloads FLAC albums to their computer
2. Simple import flow in the app: scan a folder → read metadata (artist, album, track, cover art) → index in SQLite
3. For mobile: sync selected albums to device storage, or stream from local Bun server on the same WiFi

### Metadata Extraction

- **On import:** Use `music-metadata` (Node.js/Bun) to read FLAC/MP3 tags (ID3v2, Vorbis Comments)
- **Cover art:** Extract embedded cover art or fetch from MusicBrainz Cover Art Archive (free, no auth)
- **Missing metadata:** Query MusicBrainz by fingerprint (AcoustID + Chromaprint) for auto-tagging

```
User's FLAC folder → Bun server scans → music-metadata extracts tags
                                        → SQLite stores metadata
                                        → Cover art extracted/fetched
                                        → Available for playback via HTTP
```

### Audio Formats Supported

| Format | Priority | Notes |
|--------|----------|-------|
| **FLAC** | Primary | Standard for torrented hi-res |
| **MP3** | Required | Legacy files, VK Music output |
| **AAC/M4A** | Required | SoundCloud, YouTube rips |
| **WAV** | Optional | Studio masters |
| **ALAC** | Optional | Apple ecosystem |

### Local Server (Bun + Hono)

Simple HTTP server running on the user's Mac/PC:
- Serves audio files over HTTP to the mobile app on same network
- Handles metadata scanning and indexing
- Proxies VK/SoundCloud requests
- Runs lyrics pipeline locally

---

## 3. Music Sources: VK + SoundCloud + Local

### Architecture: Plugin-Based Providers

```
┌──────────────────────────┐
│     Musaic Provider API   │  Unified interface
│     (TypeScript)          │
└────────────┬─────────────┘
             │
   ┌─────────┼─────────┐
   │         │         │
   v         v         v
┌──────┐ ┌──────┐ ┌──────┐
│Local │ │ VK   │ │Sound │
│FLAC  │ │Music │ │Cloud │
└──────┘ └──────┘ └──────┘
```

Each provider implements:
```typescript
interface MusicProvider {
  search(query: string): Promise<Track[]>
  getStreamUrl(trackId: string): Promise<string>
  getTrackMetadata(trackId: string): Promise<TrackMeta>
  getArtistTracks(artistId: string): Promise<Track[]>
}
```

### VK Music Provider

**Method:** Emulate official VK client (Kate Mobile token approach)

**Libraries:**
- `vk-audio-token` — obtain audio token via Kate Mobile app credentials
- Custom HTTP client for VK audio API (undocumented endpoints)

**Key endpoints (unofficial):**
```
audio.get          — user's audio library
audio.search       — search tracks
audio.getById      — get specific track
audio.getPopular   — popular tracks
audio.getRecommendations — VK's reco engine
```

**Quality:** MP3 128-320kbps (variable)

**Caveats:**
- Audio URLs expire (typically 24h) and are IP-bound
- Need to refresh tokens periodically
- Account ban risk exists — use a secondary account
- Rate limits: ~3 req/sec safe

**Implementation plan:**
1. Auth via Kate Mobile token flow
2. Cache track metadata in SQLite
3. Stream audio URLs on-demand (re-fetch when expired)
4. Download to local storage for offline play

### SoundCloud Provider

**Method:** yt-dlp extractor + direct API

**Approach:**
- Use `yt-dlp` as a backend tool for reliable stream extraction
- SoundCloud client_id can be extracted from their web app (rotates, need auto-refresh)
- Direct API v2 endpoints still work with valid client_id

**Key endpoints:**
```
GET /tracks/{id}/stream    — stream URL (with client_id)
GET /search/tracks?q={}    — search
GET /users/{id}/tracks     — artist tracks
GET /tracks/{id}           — metadata
```

**Quality:** Opus 64kbps (free), AAC 256kbps (Go+ only, not accessible)

**Caveats:**
- client_id rotation — need scraper to extract from soundcloud.com
- Rate limited — cache aggressively
- Opus 64kbps quality is poor — SoundCloud is better for discovery than quality listening

**Implementation plan:**
1. client_id auto-extractor (scrape from SC web app JS bundle)
2. Search + metadata via direct API
3. Stream via yt-dlp fallback when direct API fails
4. Cache metadata in SQLite

### Local FLAC Provider

Simplest provider — reads from indexed SQLite database, serves files over HTTP from local Bun server.

### Provider Priority

1. **Local FLAC** — always preferred when track exists locally (best quality)
2. **VK Music** — large Russian + international catalog, decent quality
3. **SoundCloud** — indie/underground music, remixes, DJ mixes

---

## 4. AI Music Recommendation

### Budget-First Approach

For 1-2 users, we can use OpenRouter free-tier models + Last.fm API (free, no limits for personal use).

### Model Selection

| Use Case | Model | Cost |
|----------|-------|------|
| Quick recommendations | `minimax/minimax-m2.5:free` | $0 (200 req/day) |
| Taste analysis | `google/gemini-2.0-flash-lite:free` | $0 |
| Conversational discovery | `minimax/minimax-m2.5` | $0.20/M input (pennies) |

**For 1-2 users, the free tier is more than enough.** 200 requests/day = ~6 recommendation sessions per day, each with multiple back-and-forth.

### Recommendation Flow

```
1. User plays/likes/skips → log to SQLite (track_id, action, timestamp)
2. Build taste profile from listening history:
   - Top genres, artists, moods (from Last.fm tags)
   - Average tempo, energy level
3. Get candidates:
   - Last.fm similar tracks/artists (free API, 5 req/sec)
   - VK Music recommendations (built-in VK reco engine)
4. LLM re-ranks and explains:
   - Send taste profile + candidate list to MiniMax
   - Get ranked recommendations with reasoning
```

### Last.fm Integration (Free, Core of Reco Engine)

```
# Similar tracks
GET /2.0/?method=track.getSimilar&artist={}&track={}&api_key={}&format=json

# Similar artists
GET /2.0/?method=artist.getSimilar&artist={}&api_key={}&format=json

# Top tracks by mood/genre tag
GET /2.0/?method=tag.getTopTracks&tag=chill&api_key={}&format=json

# Scrobble (track listening for better reco over time)
POST /2.0/?method=track.scrobble&...
```

Last.fm is the backbone — it has decades of listening data. LLM adds conversational layer on top.

### Prompt Template

```
You are Musaic AI. The user's taste profile:
- Top artists: {artists}
- Top genres: {genres}
- Recent mood: {mood}
- Last 10 tracks: {tracks}

Candidate tracks from Last.fm: {candidates}

Pick the 10 best matches. Explain each pick in 1 sentence.
Return JSON: [{ "artist": "", "track": "", "reason": "" }]
```

---

## 5. AI Lyrics: Parakeet TDT v3

### Why Parakeet over Whisper

| Feature | Parakeet TDT v3 | Whisper large-v3 |
|---------|-----------------|------------------|
| Model size | 0.6B params | 1.5B params |
| WER (English) | **6.34%** | ~10% |
| Speed | **~24x real-time** on A100 | ~6x real-time |
| Word timestamps | Yes (built-in) | Yes |
| Languages | 25 European (incl. Russian) | 99 languages |
| License | CC-BY-4.0 | MIT |
| GPU requirement | Runs on **T4/V100** (consumer GPUs) | Needs V100+ |
| Local inference | Yes (NeMo toolkit) | Yes |

Parakeet is faster, more accurate on English, and runs on cheaper hardware. Trade-off: fewer languages (25 vs 99), but covers all European languages including Russian — sufficient for our catalog.

### Lyrics Pipeline

```
Audio → Demucs (vocal separation) → Parakeet TDT v3 (ASR) → LLM cleanup → LRC
```

**Step 1: Vocal Separation (Demucs)**
```python
from demucs.pretrained import get_model
from demucs.apply import apply_model

model = get_model('htdemucs')
# Separates: vocals, drums, bass, other
# Output: isolated vocal track
```
- Runs on CPU (slow but works) or GPU (fast)
- On MacBook M-series: ~30 seconds per 4-minute song
- Critical for accuracy — without it, music background destroys ASR

**Step 2: ASR (Parakeet TDT v3)**
```python
import nemo.collections.asr as nemo_asr

asr = nemo_asr.models.ASRModel.from_pretrained("nvidia/parakeet-tdt-0.6b-v3")
output = asr.transcribe(['vocals.wav'], timestamps=True)

# Word-level timestamps for synced lyrics
for word in output[0].timestamp['word']:
    print(f"{word['start']:.2f}s → {word['end']:.2f}s : {word['word']}")
```
- Runs locally on Mac GPU (MPS) or CPU
- ~2-3 minutes per song on M1/M2 Mac (CPU)
- Automatic punctuation and capitalization

**Step 3: LLM Post-Processing (OpenRouter)**
```
Fix transcription errors, format into verse/chorus structure.
Input: raw ASR output with timestamps
Output: cleaned lyrics in LRC format
```
- MiniMax free tier handles this easily
- Cost: $0

**Step 4: Generate Synced LRC**
```
[00:12.50] I've been waiting for this moment
[00:15.80] All my life, oh lord
[00:18.20] Can you feel it coming in the air tonight?
```

### Lyrics Lookup (Before AI)

Always check databases first — cheaper and more accurate:

```
1. Local cache (SQLite)          → instant
2. LRCLIB (free, 3M+ synced)    → GET https://lrclib.net/api/get?artist={}&track={}
3. AI pipeline (Demucs + Parakeet) → last resort, ~3 min processing
```

### Running Locally on Mac

All components run on a MacBook:
- **Demucs:** `pip install demucs` — runs on MPS (Apple GPU) or CPU
- **Parakeet:** `pip install nemo_toolkit[asr]` — runs on MPS or CPU
- **Total processing time:** ~3-5 minutes per song on M1/M2 Mac
- **Total cost:** $0 (all local, all open-source)

### Animated Lyrics Display (Apple Music-style)

- Parse LRC timestamps into React Native Reanimated shared values
- Active line: white, scale 1.05, full opacity
- Past lines: gray, scale 0.95, fade
- Driven by RNTP playback progress callback
- Smooth spring animations between lines

---

## 6. Architecture Overview

### System Architecture (Personal Scale)

```
┌─────────────────────────────────────────────────────┐
│               MUSAIC MOBILE APP                      │
│           React Native (Expo SDK 53)                 │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Player   │  │ Library  │  │ AI Chat          │  │
│  │ (RNTP)   │  │ Browser  │  │ (Recommendations)│  │
│  ├──────────┤  ├──────────┤  ├──────────────────┤  │
│  │ Lyrics   │  │ Search   │  │ Settings         │  │
│  │ (Synced) │  │ (Multi)  │  │                  │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                      │
│  State: Zustand    DB: expo-sqlite    KV: MMKV      │
└────────────────────────┬────────────────────────────┘
                         │ HTTP (local WiFi)
┌────────────────────────┴────────────────────────────┐
│              LOCAL SERVER (Bun + Hono)                │
│              Running on Mac/PC                       │
│                                                      │
│  ┌────────────────┐  ┌────────────────────────────┐ │
│  │ Audio Server    │  │ Music Providers            │ │
│  │ (serves FLAC    │  │ - LocalFLACProvider        │ │
│  │  over HTTP)     │  │ - VKMusicProvider          │ │
│  │                 │  │ - SoundCloudProvider       │ │
│  └────────────────┘  └────────────────────────────┘ │
│                                                      │
│  ┌────────────────┐  ┌────────────────────────────┐ │
│  │ Lyrics Pipeline │  │ Metadata                   │ │
│  │ - Demucs        │  │ - music-metadata (tags)    │ │
│  │ - Parakeet v3   │  │ - MusicBrainz (lookup)     │ │
│  │ - LLM cleanup   │  │ - Last.fm (similar/reco)   │ │
│  └────────────────┘  └────────────────────────────┘ │
│                                                      │
│  AI: OpenRouter (MiniMax free tier)                  │
└──────────────────────────────────────────────────────┘
```

### Key Decisions for Personal Scale

1. **No cloud backend** — everything runs locally. Bun server on Mac, SQLite on device.
2. **No CDN** — audio served over local WiFi from Bun server, or synced to device storage.
3. **Free AI tier** — OpenRouter free models (200 req/day) more than enough for 1-2 users.
4. **Local lyrics processing** — Demucs + Parakeet run on Mac GPU. $0 cost per song.
5. **VK + SoundCloud mandatory** — implemented as provider plugins despite legal gray area. Personal use only.

---

## 7. Development Phases

### Phase 1: Project Setup + Skeleton
**Duration:** 1-2 days
- Initialize Expo project with TypeScript
- Set up navigation (tab bar + stacks)
- Configure RNTP for audio playback
- Set up Zustand stores (player, library)
- Create basic glassmorphism theme from DESIGN.md tokens
- Empty screen shells: Home, Search, Library, Now Playing

### Phase 2: Local Music Library + Player
**Duration:** 3-4 days
- Bun + Hono local server setup
- Folder scanning + metadata extraction (`music-metadata`)
- SQLite schema: tracks, albums, artists, playlists
- Track list UI + album grid
- Full player: play/pause, next/prev, progress bar, queue
- Album art display (extracted or MusicBrainz)
- Background playback + lock screen controls

### Phase 3: VK Music Integration
**Duration:** 3-4 days
- VK auth flow (Kate Mobile token)
- VKMusicProvider: search, stream, user library
- Audio URL caching + refresh on expiry
- VK track results in unified search
- Download-to-local for offline VK tracks

### Phase 4: SoundCloud Integration
**Duration:** 2-3 days
- client_id auto-extractor
- SoundCloudProvider: search, stream, artist pages
- yt-dlp fallback for stream extraction
- SC results in unified search
- Waveform display (SC provides waveform data)

### Phase 5: AI Music Recommendations
**Duration:** 2-3 days
- Last.fm API integration (similar tracks/artists, scrobbling)
- Listening history tracking (SQLite)
- Taste profile builder
- OpenRouter integration (MiniMax free tier)
- AI chat UI for conversational music discovery
- "More like this" quick action on any track

### Phase 6: AI Lyrics (Parakeet TDT v3)
**Duration:** 3-4 days
- LRCLIB integration (free synced lyrics lookup)
- Lyrics display UI (scrolling, synced to playback)
- Demucs vocal separation pipeline (Bun server)
- Parakeet TDT v3 ASR pipeline (Bun server)
- LLM post-processing (OpenRouter)
- LRC generation + caching
- Apple Music-style animated lyrics (Reanimated)

### Phase 7: UI Polish + Glassmorphism
**Duration:** 3-4 days
- Full glassmorphism implementation per DESIGN.md
- Ambient gradient backgrounds
- Glass card components with blur
- Smooth page transitions
- Player expand animation (mobile)
- Genre/mood tag chips
- Playlist of the Day hero card
- Recent Played sidebar (tablet/desktop)

### Phase 8: Testing + Release
**Duration:** 1-2 days
- End-to-end testing all providers
- Offline mode testing
- Build iOS/Android binaries
- Install on personal devices

**Total estimated development: ~20-25 days**

---

## 8. Cost Estimate

### Monthly Running Cost

| Component | Cost |
|-----------|------|
| OpenRouter AI (free tier) | $0 |
| Last.fm API | $0 |
| LRCLIB | $0 |
| MusicBrainz | $0 |
| Bun server (own Mac) | $0 (electricity) |
| Demucs + Parakeet (own Mac) | $0 |
| Apple Developer (for iOS builds) | $99/year ($8.25/mo) |
| **Total** | **~$8/mo** (just Apple dev account) |

### One-Time Costs

| Item | Cost |
|------|------|
| Apple Developer Program | $99/year |
| Android (if Play Store) | $25 one-time |

### If Free-Tier AI Not Enough

| Upgrade | Cost |
|---------|------|
| MiniMax M2.5 (paid) | ~$1-3/mo for personal use |
| Gemini Flash (paid) | ~$0.50-1/mo |

**Bottom line: This can run for ~$0-8/month.**

---

*Updated from v1 to reflect personal-scale architecture. See `DESIGN.md` for visual design specification.*
