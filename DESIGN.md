# Musaic — Design Specification

> Design system and UI specification for the Musaic music app.
> Based on reference analysis: dark glassmorphism, minimalist, warm aesthetic.

---

## 1. Design Philosophy

| Principle | Description |
|-----------|-------------|
| **Glassmorphism** | Semi-transparent frosted-glass cards with backdrop blur over a rich background |
| **Dark-first** | Deep dark base with warm ambient gradients; no pure black (#000) |
| **Minimalism** | Clean hierarchy, generous whitespace, no visual clutter |
| **Content-forward** | Album art and music metadata are the visual anchors; chrome stays invisible |
| **Warm & Immersive** | Subtle warm gradients at screen edges create depth and atmosphere |

---

## 2. Color Palette

### Base Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#0d0d14` | App background base |
| `--bg-secondary` | `#1a1a2e` | Elevated surfaces (sidebar, cards) |
| `--bg-tertiary` | `#252540` | Hover states, active surfaces |

### Glass Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--glass-bg` | `rgba(255, 255, 255, 0.05)` | Default glass card background |
| `--glass-bg-hover` | `rgba(255, 255, 255, 0.08)` | Hovered glass elements |
| `--glass-bg-active` | `rgba(255, 255, 255, 0.12)` | Active/selected glass elements |
| `--glass-border` | `rgba(255, 255, 255, 0.10)` | Subtle border on glass cards |
| `--glass-blur` | `20px` | Backdrop blur radius |

### Text Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--text-primary` | `#ffffff` | Headings, song titles, primary labels |
| `--text-secondary` | `rgba(255, 255, 255, 0.60)` | Artist names, metadata, timestamps |
| `--text-tertiary` | `rgba(255, 255, 255, 0.40)` | Disabled text, placeholders |

### Accent Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--accent-primary` | `#e91e8c` | Primary CTA, active indicators, brand highlights |
| `--accent-gradient` | `linear-gradient(135deg, #e91e8c, #ff6b6b)` | Upgrade cards, prominent CTAs |
| `--accent-purple` | `#7c3aed` | Secondary accent (tags, badges) |
| `--accent-green` | `#22c55e` | Playing indicator, success states |

### Ambient Gradients (Background Layer)

| Token | Value | Usage |
|-------|-------|-------|
| `--ambient-warm` | `radial-gradient(ellipse at bottom left, rgba(139, 92, 46, 0.30), transparent 60%)` | Warm glow at bottom-left of viewport |
| `--ambient-cool` | `radial-gradient(ellipse at top right, rgba(59, 46, 139, 0.15), transparent 60%)` | Cool accent at top-right |

---

## 3. Typography

**Font Family:** `'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif`

| Style | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| `heading-xl` | 28px | 700 | 1.2 | Page titles |
| `heading-lg` | 22px | 700 | 1.3 | Section headers ("Playlist of the day") |
| `heading-md` | 18px | 600 | 1.3 | Card titles, song titles in player |
| `heading-sm` | 15px | 600 | 1.4 | Subsection headers |
| `body` | 14px | 400 | 1.5 | Track names in list, descriptions |
| `body-sm` | 12px | 400 | 1.5 | Artist names, metadata, timestamps |
| `caption` | 11px | 500 | 1.4 | Tag labels, tiny metadata |
| `button` | 14px | 600 | 1.0 | Button text |

---

## 4. Spacing & Grid

| Token | Value |
|-------|-------|
| `--space-xs` | `4px` |
| `--space-sm` | `8px` |
| `--space-md` | `12px` |
| `--space-lg` | `16px` |
| `--space-xl` | `24px` |
| `--space-2xl` | `32px` |
| `--space-3xl` | `48px` |

### Layout Grid (Desktop)

```
┌────────────────────────────────────────────────────────────┐
│  Left Sidebar (240px)  │  Main Content (flex)  │  Right Sidebar (280px)  │
│  fixed                 │  scrollable           │  fixed                  │
├────────────────────────┴───────────────────────┴───────────────────────┤
│                        Bottom Player Bar (80px, fixed)                 │
└────────────────────────────────────────────────────────────────────────┘
```

### Layout Grid (Mobile)

```
┌──────────────────────┐
│  Main Content (full) │
│  scrollable          │
├──────────────────────┤
│  Bottom Player (64px)│
├──────────────────────┤
│  Tab Bar (56px)      │
└──────────────────────┘
```

- Mobile breakpoint: `< 768px`
- Tablet breakpoint: `768px – 1024px`
- Desktop: `> 1024px`

---

## 5. Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `8px` | Small chips, tags, input fields |
| `--radius-md` | `12px` | Cards, buttons, dropdowns |
| `--radius-lg` | `16px` | Large cards, modals |
| `--radius-xl` | `20px` | Featured cards, hero sections |
| `--radius-full` | `9999px` | Circular elements (avatars, play button) |

---

## 6. Shadows & Effects

| Effect | Value |
|--------|-------|
| Glass card shadow | `0 8px 32px rgba(0, 0, 0, 0.30)` |
| Elevated shadow | `0 4px 16px rgba(0, 0, 0, 0.20)` |
| Subtle shadow | `0 2px 8px rgba(0, 0, 0, 0.15)` |
| Glass backdrop | `backdrop-filter: blur(var(--glass-blur))` |
| Inner glow (active) | `inset 0 0 0 1px rgba(255, 255, 255, 0.10)` |

---

## 7. Component Specifications

### 7.1 Left Sidebar

- **Width:** 240px (desktop), hidden on mobile (replaced by tab bar)
- **Background:** `var(--glass-bg)` with blur, `var(--glass-border)` right edge
- **Content:**
  - Navigation links (Home, Search, Explore) with icons — 20px icon + 14px label
  - Divider line (`rgba(255,255,255,0.06)`, 1px)
  - "Your Library" header with search icon
  - Filter tabs: Playlists | Albums | Podcasts (chip style, `var(--radius-sm)`)
  - Library list items: 48px album art (rounded `var(--radius-sm)`) + title + subtitle + type badge
  - "+ new playlist" button at bottom (outline style, `var(--glass-border)`)

### 7.2 Main Content Area

#### Search Bar
- **Height:** 40px
- **Background:** `var(--glass-bg)`, border `var(--glass-border)`
- **Border radius:** `var(--radius-full)` (pill shape)
- **Placeholder:** "Search by artists, songs or albums" in `var(--text-tertiary)`
- **Icons:** Search (left), microphone (right)

#### Genre/Mood Tags
- **Layout:** Horizontal scroll row
- **Tag style:** Pill chips, `var(--radius-full)`, padding `6px 16px`
- **Background:** `var(--glass-bg)`, border `var(--glass-border)`
- **Active state:** `var(--accent-primary)` background, white text
- Tags: Energise, Feel good, Relax, Workout, Sad, Party, Focus, Romance, Sleep

#### Playlist of the Day (Hero Card)
- **Height:** ~220px
- **Border radius:** `var(--radius-xl)`
- **Background:** Album art as background with dark overlay gradient (`linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0.2))`)
- **Content overlay:**
  - Metadata: "49 songs · 4 hours 37 minutes" (`body-sm`, `var(--text-secondary)`)
  - Title: "Playlist of the day" (`heading-lg`, white)
  - Album name: e.g. "Blue" (`heading-xl`, white)
  - Artist badge: Artist name + date tag
  - Play button: 56px circle, white, centered
  - Progress bar: thin (3px), pink accent fill, rounded

#### Content Tabs
- **Style:** Underlined text tabs
- **Tabs:** Playlist, Artists, Albums, Streams, Favorites
- **Active:** White text + 2px bottom border in `var(--accent-primary)`
- **Inactive:** `var(--text-secondary)`

#### Track List
- **Row height:** 56px
- **Columns:** # (index) | Album art (40px, `var(--radius-sm)`) + Title + Artist | Duration
- **Hover:** `var(--glass-bg-hover)` background
- **Playing indicator:** `var(--accent-green)` animated bars icon replacing track number
- **Dividers:** None (clean rows, separation by whitespace)

### 7.3 Right Sidebar

- **Width:** 280px (desktop), hidden on mobile
- **Background:** `var(--glass-bg)` with blur

#### Recent Played Section
- **Header:** "Recent Played" + "See All" link in `var(--accent-primary)`
- **Items:** 48px album art (rounded `var(--radius-sm)`) + song title + artist + heart icon
- **Heart icon:** Outline by default, filled pink when liked

#### Upgrade / Promo Card
- **Background:** `var(--accent-gradient)`
- **Border radius:** `var(--radius-lg)`
- **Icon:** Headphones icon with circular background
- **Text:** "Listen music offline" (heading-sm) + description (body-sm)
- **CTA:** "Upgrade Now" button, white bg, dark text, `var(--radius-md)`
- **Close button:** Small X in top-right corner

### 7.4 Bottom Player Bar

- **Height:** 80px (desktop), 64px (mobile)
- **Background:** `var(--glass-bg)` with stronger blur (30px), top border `var(--glass-border)`
- **Position:** Fixed bottom, full width
- **Layout (3 sections):**

```
┌─────────────────┬──────────────────────────┬─────────────────┐
│  Now Playing     │  Controls + Progress     │  Volume/Extra   │
│  (album art +    │  (prev/play/next +       │  (shuffle,      │
│   title/artist)  │   timeline bar)          │   repeat, vol)  │
└─────────────────┴──────────────────────────┴─────────────────┘
```

- **Album art:** 48px, rounded `var(--radius-sm)`
- **Controls:** Previous (24px), Play/Pause (40px circle, white fill), Next (24px)
- **Progress bar:** Full-width thin bar (3px) above controls, pink accent fill, time labels on sides
- **Volume:** Slider, mute icon

#### Mobile Player (Collapsed)
- **Height:** 64px
- **Shows:** Mini album art (40px) + title + artist + play/pause button
- **Tap to expand:** Full-screen player view

### 7.5 Mobile Tab Bar

- **Height:** 56px
- **Background:** `var(--bg-secondary)` with top border
- **Items:** Home, Search, Library, Profile (icon + small label)
- **Active:** `var(--accent-primary)` icon + label
- **Inactive:** `var(--text-tertiary)`

---

## 8. Glassmorphism Implementation Rules

1. **Never use pure transparent backgrounds** — always minimum `rgba(255, 255, 255, 0.03)` tint
2. **Always pair blur with a semi-transparent border** — the border defines the glass edge
3. **Layer ambient gradients behind glass elements** — the glow underneath makes the glass visible
4. **Limit glass nesting** — max 2 levels deep (glass on glass gets muddy)
5. **Use subtle inner shadows** on glass cards for depth: `inset 0 1px 0 rgba(255, 255, 255, 0.05)`
6. **Background blur values:**
   - Sidebar/cards: `blur(20px)`
   - Player bar: `blur(30px)` (stronger for legibility)
   - Overlays/modals: `blur(40px)`

---

## 9. Iconography

- **Style:** Outlined, 1.5px stroke, rounded caps
- **Size system:** 16px (inline), 20px (nav), 24px (controls), 40px (player main)
- **Color:** `var(--text-primary)` default, `var(--text-secondary)` for secondary actions
- **Library:** Lucide Icons or Phosphor Icons (consistent with minimalist aesthetic)

### Required Icons

| Context | Icons |
|---------|-------|
| Navigation | Home, Search, Compass (Explore), Library, User |
| Player | Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Volume, VolumeX |
| Actions | Heart, HeartFilled, Plus, MoreHorizontal (three dots), Download, Share |
| Library | Music, ListMusic, Mic2 (podcasts), Disc |
| Misc | ChevronRight, X, Settings, Bell |

---

## 10. Animation & Motion

| Interaction | Animation | Duration | Easing |
|-------------|-----------|----------|--------|
| Page transitions | Fade + slide up 8px | 250ms | `ease-out` |
| Card hover | Scale 1.02 + shadow lift | 200ms | `ease-out` |
| Glass card appear | Fade in + blur (0→20px) | 300ms | `ease-out` |
| Button press | Scale 0.97 | 100ms | `ease-in-out` |
| Player expand (mobile) | Slide up from bottom | 350ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Track list item appear | Stagger fade-in, 30ms delay per item | 200ms | `ease-out` |
| Playing indicator | Equalizer bars loop | 600ms | `ease-in-out`, infinite |
| Progress bar | Smooth width transition | 100ms | `linear` |

---

## 11. Screen Map

### Mobile Screens

| Screen | Description |
|--------|-------------|
| **Home** | Featured playlist hero + genre tags + recent tracks list |
| **Search** | Search bar + genre grid (large cards) + results list |
| **Library** | Tabs (Playlists/Albums/Podcasts) + grid/list toggle + library items |
| **Playlist Detail** | Hero header (album art blur bg) + track list |
| **Artist Detail** | Artist banner + popular tracks + albums grid |
| **Now Playing** | Full-screen expanded player with large album art, lyrics, queue |
| **Profile** | Settings, account info, theme toggle |

### Desktop Screens

| Screen | Description |
|--------|-------------|
| **Main** | Three-column layout as described (sidebar + content + recent) |
| **Search Results** | Main area becomes search results (tracks, artists, albums, playlists sections) |
| **Playlist/Album Detail** | Hero card replaces "playlist of the day", track list below |
| **Artist Page** | Banner + top tracks + discography + similar artists |

---

## 12. Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| `< 768px` | Single column. Sidebars hidden. Tab bar visible. Player collapsed. |
| `768px – 1024px` | Left sidebar visible (compact, icons only 64px). Right sidebar hidden. |
| `> 1024px` | Full three-column layout. Both sidebars visible. |
| `> 1440px` | Max content width 1400px, centered. Sidebars stretch. |

---

## 13. Key Interaction Patterns

### Track Playback
1. Tap/click track row → begins playback, player bar updates
2. Player bar shows current track info + controls
3. Mobile: tap player bar → expands to full-screen Now Playing
4. Desktop: double-click row = play, single-click = select

### Library Management
1. "+ new playlist" → modal with name input
2. Long-press/right-click track → context menu (Add to playlist, Like, Share, Queue)
3. Heart icon toggles liked status with scale animation
4. Drag-and-drop to reorder playlist tracks (desktop)

### Search
1. Focus search bar → genre cards grid appears
2. Typing → real-time results (debounced 300ms)
3. Results grouped: Top Result card + Songs + Artists + Albums + Playlists

---

## 14. Asset Requirements

| Asset | Format | Notes |
|-------|--------|-------|
| Album covers | JPEG/WebP | 300x300 standard, 600x600 for hero cards |
| Artist photos | JPEG/WebP | 400x400 square, with blur-expanded version for banners |
| App icon | PNG/SVG | Musaic logo, works on dark and light backgrounds |
| Placeholder art | SVG | Music note icon on gradient background for missing art |
| Background gradient | CSS | Generated via CSS radial gradients, not images |

---

## 15. Tech Stack Recommendation

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | React Native (Expo) | Cross-platform mobile (iOS + Android) from single codebase |
| Styling | NativeWind (Tailwind for RN) | Rapid styling matching this spec's token system |
| Navigation | React Navigation | Standard for RN, supports tab bar + stack + bottom sheet |
| State | Zustand | Lightweight, perfect for player state + library management |
| Audio | expo-av or react-native-track-player | Background playback, lock screen controls |
| Glass effects | `expo-blur` (BlurView) | Native blur for glassmorphism |
| Icons | Lucide React Native | Clean outlined icons matching design language |
| Animations | React Native Reanimated | Smooth 60fps animations for player transitions |

---

## 16. Accessibility

| Requirement | Guideline |
|-------------|-----------|
| **Touch targets** | All interactive elements: minimum 44×44px touch target |
| **Text contrast** | WCAG AA — 4.5:1 for body text, 3:1 for large text (≥18px or ≥14px bold) |
| **Reduced motion** | Skip animations when `useReducedMotion()` / `prefers-reduced-motion` is true |
| **Screen reader labels** | All icon-only buttons must have accessible labels (`accessibilityLabel` / `aria-label`) |

---

*This specification should be used as the source of truth for implementing all Musaic UI screens and components.*
