# Musaic — Design Specification

> Design system for the Musaic music app: dark, warm, glassmorphism, content-first.
> Source of truth for color tokens: the `Color` extension at the bottom of
> `MusaicApp/MusaicApp.swift`. The palette is **gold** — the pink `#e91e8c` from
> early specs is retired and must not return.

---

## 1. Design Philosophy

| Principle | Description |
|-----------|-------------|
| **Glassmorphism** | Translucent frosted cards over a rich artwork-driven background |
| **Dark-first** | Deep warm dark base; never pure black (#000) |
| **Minimalism** | Clean hierarchy, generous whitespace, invisible chrome |
| **Content-forward** | Album art and track metadata are the visual anchors |
| **Warm & Immersive** | Ambient gradients around artwork create depth |
| **Motion with intent** | Every animation is short, eased and honors Reduce Motion |

---

## 2. Color Palette

### Canonical tokens

| Token | Value | Usage |
|-------|-------|-------|
| `accent` | `#e6d8c3` | Warm gold accents |
| `accentStrong` | `#cdb69a` | Active track title, current lyric word, progress tint |
| `textPrimary` | `#fbf7f1` | Primary text (warm white) |
| `textSecondary` | `#c9bfb4` | Secondary text |
| `textMuted` | `#9b9187` | Meta text: durations, indices, captions |
| `bgPrimary` | `#090807` | App base |
| `bgSecondary` | `#151210` | Elevated surfaces |
| `bgTertiary` | `#2a241f` | Hover / pressed surfaces |

### Ambient gradients

| Where | Gradient |
|-------|----------|
| Artwork placeholder tile | `#4d3f30 → #241c15` (topLeading → bottomTrailing) |
| Widget background | `#1a1410 → #0d0b09` |
| Lyrics sheet backdrop | `#1a1510 → #0a0908 → #0d0b09` (top → bottom) |
| Logo orb | radial `#f0d09d → #7f5f43` |
| Now Playing | full-bleed artwork palette (`ArtworkColorService`) blurred behind glass |

---

## 3. Glass & Surfaces

- Card fill: `Color.white.opacity(0.03–0.12)`. State ladder for rows: 0.05 default → 0.09 hover (macOS) → 0.12 current.
- Borders: 0.5pt `white.opacity(0.05–0.15)`.
- Floating toasts / mini-player accents: `.ultraThinMaterial`, border `white.opacity(0.08–0.10)`, shadow `black.opacity(0.4), radius 18, y: 8`.
- Source dot on artwork corners: 9pt circle filled with the source color, `bgPrimary` 1.5pt separator ring.

---

## 4. Radius & Spacing

| Token | Value | Usage |
|-------|------|-------|
| row | 22 | Track rows |
| artwork | 12 | Artwork tiles (52pt rows, 40–46pt queue/compact) |
| card / field | 16–18 | Inputs, cards, toasts (18) |
| sheet | 32 | Presentation corner radius |
| pill | capsule | Chips, buttons, badges |

---

## 5. Typography

- Design: `.rounded` for titles/labels; default design for meta text.
- Scale: hero 42 bold · screen titles 18 bold · lyrics 22 semibold · row title `.subheadline` medium · meta `.caption`/`.caption2`.
- Times use monospaced digits with `contentTransition(.numericText())`.
- Known gap: most sizes are fixed `system(size:)` — Dynamic Type migration is tracked in `tasks.md`.

---

## 6. Motion

| Interaction | Spec |
|-------------|------|
| Track list entrance | fade-in + 8pt rise, 200ms ease-out, 30ms stagger per row, capped at 12 steps; **once per row per launch** |
| Row state change (current / hover) | 180–250ms ease-out |
| Title/artist change | `contentTransition(.opacity)`, ~280ms |
| Like | `symbolEffect(.bounce.up.byLayer)` + `contentTransition(.symbolEffect(.replace.downUp))`, soft haptic, `sensoryFeedback(.success)` |
| Lyrics auto-scroll | `.smooth(duration: 0.55)`; pauses 4s after a user drag, "Back to lyrics" pill appears |
| Karaoke word | color + bold swap on the sung word; no layout animation |
| Swipe actions | row translates with 200–220ms ease-out settle |
| iPod wheel | haptic detent every 15° of rotation; wheel ring rotates with the finger |

All animations must respect `accessibilityReduceMotion` (state flips instantly).

---

## 7. Components (inventory)

- **Shell**: `AppBackdrop`, `GlassModifier`, `PressableScale`, `PlayingIndicator`, `ErrorRetryView`, empty states.
- **Lists**: `TrackRow` (tap = play · swipe = like / add-to-playlist / add-to-queue · context menu · download state), `QueueTrackRow`, `ImportTrackRow`.
- **Player**: `MiniPlayerView`, `NowPlayingView`, `NowPlayingTransportDeck`, `ScrubBar`, `NowPlayingBackdrop`, `IPodWheelView`.
- **Lyrics**: `LyricsSheet`, `LyricsLineView` (karaoke), `LyricsHeaderView`.
- **Artwork**: `InspectableArtworkView` / `ArtworkPipeline` (two-level cache + inspection telemetry), `ArtworkColorService` (palette from cover).
- **Surfaces**: widget `MusaicWidget`, Live Activity `MusaicLiveActivityWidget`, watch app `MusaicWatch`.

---

## 8. Live Activity & Widget

- Lock screen banner: 52pt artwork · title/artist · thin progress in `accentStrong` · play/pause + next.
- Dynamic Island: compact = artwork + play/pause; expanded = title/artist + transport row (prev / play-pause / next); minimal = waveform glyph in `accentStrong`.
- Widget (systemMedium): snapshot + play/pause & next buttons.
- Controls mail commands to the app via the App Group mailbox (`NowPlayingShared`) — the extension never touches the player directly.

---

## 9. Karaoke rendering

| Word state | Style |
|------------|-------|
| Sung | `textPrimary` @ 85% |
| Current word | `accentStrong`, bold |
| Upcoming (active line) | `textPrimary` @ 55% |
| Other lines | `textPrimary` @ 38% |

Tap a line to seek (light haptic; tapped line highlights for ~300ms).

---

## 10. Accessibility

- All controls carry `accessibilityLabel`s; decorative elements are `accessibilityHidden`.
- Reduce Motion disables stagger, wheel rotation and bounce effects.
- Hover affordances are macOS-only and must no-op safely on iOS.
