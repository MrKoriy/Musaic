# Musaic — Technical Research & Platform Notes (2026-09)

> What was evaluated, what won, and why. Product roadmap lives in
> `MY-WAVE-PLAN.md`; the executable backlog is `tasks.md`.

---

## 1. Lyrics: forced alignment instead of full diarization

Goal: Apple-Music-grade sync (≤ 200 ms) on a small VPS, CPU only.

| Option | Verdict |
|--------|---------|
| Raw LRCLIB timestamps | ✗ human-typed, lags the vocal ~0.4 s |
| WhisperX / SOFA full pipeline | ✗ minutes per track on a VPS |
| whisper.cpp `--max-len 1` + reference-text alignment | ✓ chosen |

Pipeline (`server/src/providers/lyrics-aligner.ts`):

1. ffmpeg → 16 kHz mono WAV.
2. whisper.cpp word-level JSON (per-word offsets).
3. Reference lyrics (LRCLIB/Genius plaintext) tokenised.
4. Greedy sliding-window alignment (window 12, ≤ 1-char fuzzy tolerance).
5. Line start = earliest matched word; unmatched lines interpolated between neighbours.
6. ~0.15 s perceptual lead subtracted (highlight lands just before the vowel onset).

Output: LRC **plus per-word timings** (JSON stored in `lyrics_cache.words`, served as `words` in `GET /api/lyrics/:id`).

Fallbacks: raw whisper.cpp transcription (`source: ai`), OpenRouter cloud transcription.

**Highlight offset** is server-computed per source (`offsetSec`): LRCLIB 0.4 s · `ai` 0.15 s · `aligned` 0 s. The old client-side `globalLyricsOffset = 0.4` hack is gone.

Word timings for unmatched words are interpolated between matched neighbours inside the line (280 ms step), so karaoke never stalls on ASR gaps.

---

## 2. Loudness normalization (ReplayGain-style)

- **Measure**: REPLAYGAIN_TRACK_GAIN/PEAK tags when the file carries them (instant), else `ffmpeg -af ebur128=peak=true` — incremental job `jobs/loudness-scan.ts` (200 tracks/run, re-scheduled hourly until the library is covered).
- **Store**: `tracks.loudness_lufs / loudness_peak_db / loudness_source` (migration v22).
- **Apply**: `AudioPlayer.normalizationVolume(forLoudness:)` — target −16 LUFS, RG2 reference −18. Base volume per track; crossfade/sleep-timer ramps multiply on top.

---

## 3. Recommendations

See `MY-WAVE-PLAN.md`. Shape: candidate generation (library + artist graph + tags + audio embeddings) → taste profile → trained linear ranker (stratified CV, persisted baseline) → session feedback loop (skip/like/dislike outcomes, seed-buffer repeat guard, skip-streak refresh).

---

## 4. iOS 27 (WWDC26) adoption map

Toolchain note: CI builds with **Xcode 26.6** (no iOS 27 SDK), so iOS-27-only APIs must be compile-gated (`#if compiler(>=6.3)` + `if #available(iOS 27, macOS 27, *)`) or adopted after the toolchain bump. Deployment target stays iOS 17 / macOS 15.

| Feature | Status | Notes |
|---------|--------|-------|
| Live Activities / Dynamic Island | ✅ adopted | `NowPlayingLiveActivity.swift`, `NowPlayingActivityController` |
| Interactive widget buttons (App Intents) | ✅ adopted | via App Group command mailbox |
| Custom swipe actions in any container | ✅ adopted | plain drag gesture in `TrackRow` — works on iOS 17+ today |
| Loudness/ReplayGain playback normalization | ✅ adopted | §2 |
| `swipeActionsContainer()` + `swipeActions(onPresentationChanged:)` | 🟡 planned | replace the custom gesture once building with Xcode 27 |
| `reorderContainer` / `reorderable()` | 🟡 planned | queue + playlists; same API on watchOS 27 |
| `dragContainer` lazy drags | 🟡 planned | large libraries (20k+ rows) |
| Item-based `alert(_:item:)` / `alert(error:)` | 🟡 planned | replaces bool-flag alerts (lyrics manual search, Home errors) |
| `AsyncImage(request:)` + built-in HTTP cache | 🟡 optional | non-inspect artwork paths (widget, avatars) |
| `toolbarMinimizeBehavior`, `visibilityPriority`, `ToolbarOverflowMenu`, `topBarPinnedTrailing` | 🟡 planned | detail-view toolbars |
| `TabRole.prominent`, `NavigationTransition.crossFade` | 🟡 optional | tab polish |
| Interactive Liquid Glass | 🟡 planned | replace hand-rolled `GlassModifier` |
| `@State` lazy-init macro | ✅ free | backported to iOS 17; watch for init-pattern source breaks |
| ContentBuilder | 🟡 optional | speeds up `HomeView` type-checking |
| Resizable iPhone apps | 🟡 planned | iPad / windowed layouts |
| Document API (`ReadableDocument`/`WritableDocument`) | 💡 idea | playlist export (M3U/JSON) via `fileExporter` |
| Siri / App Intents for playback | 💡 idea | `MusaicPlaybackIntent` already exists — add phrases |

---

## 5. Widget ↔ app control channel

Widgets and Live Activities run out-of-process and cannot touch the AVPlayer.
Design: `MusaicPlaybackIntent` writes a command string into the App Group
(`NowPlayingShared.enqueueCommand`); the app drains it from the playback tick
(4 Hz) and on scene activation (`PlayerStore.processPendingWidgetCommands`).

Known limitation: if the app is fully suspended and paused, a widget command
waits until the app is next active. While audio plays (background audio mode)
the process is alive and commands apply instantly.
