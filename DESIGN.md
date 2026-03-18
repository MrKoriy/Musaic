# Musaic — Design Specification

> Reference: Spotify-like music app. Glassmorphism + dark minimalism.
> Screenshot: `/api/assets/fc423b28-d842-450c-a0d5-084f58cc79c8/content`

---

## 1. Design Philosophy

**Dark Minimalism + Subtle Glassmorphism**
- Near-black base with warm undertones
- Cards float with slight translucency and blur
- Pink/magenta as the single accent color
- Maximum content density, minimum chrome

---

## 2. Color Palette

```ts
// theme/colors.ts
export const colors = {
  // Base
  bg:           '#0d0d0d',   // deepest background
  bgElevated:   '#141414',   // panels, sidebars
  bgCard:       '#1c1c1e',   // card surfaces
  bgGlass:      'rgba(28, 28, 30, 0.7)',  // glass surface with blur

  // Borders
  border:       'rgba(255, 255, 255, 0.08)',
  borderLight:  'rgba(255, 255, 255, 0.12)',

  // Text
  textPrimary:  '#ffffff',
  textSecondary:'#8e8e93',
  textTertiary: '#636366',

  // Accent
  accent:       '#e91e8c',   // pink/magenta
  accentLight:  'rgba(233, 30, 140, 0.15)',
  accentGlow:   'rgba(233, 30, 140, 0.4)',

  // Ambient gradients (warm bottom, cool top)
  gradientWarm: ['rgba(180, 80, 40, 0.15)', 'rgba(0, 0, 0, 0)'],
  gradientCool: ['rgba(30, 60, 120, 0.1)', 'rgba(0, 0, 0, 0)'],
  gradientHero: ['rgba(233, 30, 140, 0.2)', 'rgba(13, 13, 13, 0)'],
}
```

---

## 3. Typography

```ts
// theme/typography.ts
// Font: Inter (cross-platform) or SF Pro (iOS)
export const typography = {
  hero:    { fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },
  title:   { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: '600' },
  body:    { fontSize: 15, fontWeight: '400' },
  caption: { fontSize: 13, fontWeight: '400' },
  micro:   { fontSize: 11, fontWeight: '500', letterSpacing: 0.4 },
}
```

---

## 4. Spacing & Radius

```ts
export const spacing = {
  xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32,
}

export const radius = {
  sm: 8, md: 12, lg: 16, xl: 20, full: 9999,
}
```

---

## 5. Glassmorphism Rules

### Glass Card (GlassCard)
- Background: `rgba(28, 28, 30, 0.7)`
- Blur: `BlurView intensity={40}` (expo-blur)
- Border: 1px `rgba(255,255,255,0.08)`
- Border radius: 16px
- Shadow: `rgba(0,0,0,0.3)` soft

### Glass Surface (GlassSurface)
- Background: `rgba(28, 28, 30, 0.5)`
- Blur: `BlurView intensity={20}`
- Border: 1px `rgba(255,255,255,0.06)`

### Glass Input (search bar)
- Background: `rgba(255, 255, 255, 0.07)`
- Blur: `BlurView intensity={30}`
- Border: 1px `rgba(255,255,255,0.1)`
- Border radius: full (pill shape)

### Layering constraints
1. bg (darkest) → panels → cards → glass surfaces → modals
2. Never stack more than 3 glass layers
3. Blur values: 15 (subtle), 30 (medium), 60 (strong)

---

## 6. Ambient Gradient Backgrounds

```
Screen background gradient:
  - Top area: Cool blue tint rgba(30,60,120,0.1) → transparent
  - Bottom area: Warm amber tint rgba(180,80,40,0.15) → transparent
  - Center: Pure black/transparent
```

For hero cards: pink/magenta radial glow behind album art.

---

## 7. Component Specs

### 7.1 Tag Chips (genre/mood)
- Horizontal ScrollView, no scrollbar
- Height: 32px
- Padding: 8px 14px
- Background: `rgba(255,255,255,0.07)` default, `rgba(233,30,140,0.15)` active
- Border: `rgba(255,255,255,0.1)` default, `rgba(233,30,140,0.4)` active
- Text: 13px medium, white default, accent active
- Border radius: full

### 7.2 Hero Card (Playlist of the Day)
- Full width card, height ~200px
- Album art image fills card (object-fit: cover)
- Linear gradient overlay (bottom-up: rgba(0,0,0,0.7) → transparent)
- Title + metadata text overlay on bottom-left
- Play button centered (48px, white with rgba(0,0,0,0.3) bg)
- Border radius: 16px

### 7.3 Track List Item
- Height: 56px
- Album thumbnail: 40×40px, border radius 6px
- Title 15px/600, Artist 13px secondary, Duration 13px tertiary
- On hover/active: background rgba(255,255,255,0.06)
- Track number shown when not playing, animated bars when playing
- Heart button + more (···) on right, visible on hover

### 7.4 Mini Player Bar
- Height: 64px (+ safe area)
- Glass surface (BlurView intensity=60)
- Border top: `rgba(255,255,255,0.08)`
- Album art: 42×42px, radius 6px
- Title + artist text center
- Play/pause + next buttons right
- Progress: thin line under the bar (1px accent color, animated width)

### 7.5 Expanded Player
- Full screen modal, slides up from mini player
- Large album art: 280×280px centered, radius 16px, drop shadow
- Title (20px/700) + artist (15px secondary) below art
- Heart button left of title
- Progress scrubber with time labels
- Main controls (shuffle, prev, play/pause, next, repeat)
- Volume slider
- Bottom actions (queue, lyrics, share)
- Background: ambient gradient matching album art colors

### 7.6 Sidebar (tablet/desktop — mobile uses bottom tabs)
- Width: 240px
- Background: `rgba(20,20,20,0.85)` + BlurView
- Navigation items: icon + label, 44px tall
- Active item: accent left border (3px) + text white
- Library list below

### 7.7 Bottom Tab Bar (mobile)
- 5 tabs: Home, Search, Library, (Now Playing), Profile
- Icons: 24px
- Active: accent color
- Background: glass surface with intense blur

### 7.8 Playing Indicator (animated bars)
- 3 vertical bars, 3px wide each, 2px gap
- Heights animate between 4px and 14px continuously
- Color: accent pink
- Animation: staggered ease-in-out, 0.4s each bar, different offsets

### 7.9 Heart Button (like/favorite)
- Default: outline heart, gray
- Liked: filled heart, accent pink
- Tap animation: scale 0 → 1.3 → 1.0 with spring
- Particle burst on like (6 dots, spread animation)

---

## 8. Screen Map (Mobile)

### 8.1 Home Screen
```
[Status bar]
[Header: "Good evening, Name" + avatar]
[Genre/mood tag chips — horizontal scroll]
[Playlist of the Day — hero card]
[Tabs: Playlist | Artists | Albums | Streams | Favorites]
[Track list — vertical scroll]
[Mini player — fixed bottom]
```

### 8.2 Search Screen
```
[Search input — glass pill, full width]
[Browse categories — 2-column grid]
  - Recent searches
  - Trending
[Search results — track list items]
```

### 8.3 Library Screen
```
[Header: "Your Library"]
[Filter chips: Playlists | Albums | Artists | Podcasts]
[Library items — list or 2-column grid]
[+ New playlist FAB — bottom right]
```

### 8.4 Player Screen (expanded)
```
[Back chevron + track source info]
[Large album art — rounded square, drop shadow]
[Title + Artist + Heart]
[Progress bar + time]
[Controls: shuffle prev play next repeat]
[Volume slider]
[Queue | Lyrics | Share]
```

### 8.5 Now Playing Queue (Sheet)
```
[Handle + "Next in queue" header]
[Current track highlighted in accent]
[Upcoming tracks list]
[Drag to reorder]
```

---

## 9. Animation Specs

### Page Transitions
- Navigate forward: fade in + slide up 20px (200ms ease-out)
- Navigate back: fade out + slide down 20px (200ms ease-in)
- Tab switch: crossfade only (150ms)

### Player Expand/Collapse
- Mini player → expanded: slide up (spring, stiffness=200, damping=25)
- Album art: scales from mini thumbnail position (shared element-like)

### Playing Bars (indicator)
```js
// 3 bars, staggered animation
bar1: interpolate(0→14→4→14, duration=800, delay=0)
bar2: interpolate(4→14→4→14, duration=600, delay=100)
bar3: interpolate(8→14→4→14, duration=700, delay=200)
// loop infinitely
```

### Heart Button
```js
// On like:
scale: 1 → 0 → 1.3 → 1.0  (spring)
color: gray → accent (at scale 0)
// Particle burst: 6 dots spread radially
```

### Tag Chip Selection
- Background/border color: animated via interpolateColor (150ms)

### Track Row Hover/Press
- Background opacity: 0 → 0.06 (100ms)
- Show action buttons (heart, more): fade in (150ms)

### Progress Bar
- Width animated with `Animated.timing` or reanimated's `withTiming`
- Updates every 500ms during playback

---

## 10. Tech Stack

```
React Native + Expo SDK 55
expo-blur              — BlurView for glassmorphism
expo-linear-gradient   — gradient backgrounds
react-native-reanimated — smooth 60fps animations
react-native-gesture-handler — swipe gestures
@react-navigation/native + bottom-tabs — navigation
react-native-safe-area-context — safe area
expo-haptics           — haptic feedback on interactions
```

---

## 11. Accessibility

- All interactive elements: minimum 44×44px touch target
- Text contrast: WCAG AA (4.5:1 for body, 3:1 for large text)
- Reduce motion: skip animations when `useReducedMotion()` is true
- Screen reader labels on all icon buttons
