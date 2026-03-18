// Musaic Design Tokens — from DESIGN.md
export const Colors = {
  // Base
  bgPrimary: '#0d0d14',
  bgSecondary: '#1a1a2e',
  bgTertiary: '#252540',

  // Glass
  glassBg: 'rgba(255, 255, 255, 0.05)',
  glassBgHover: 'rgba(255, 255, 255, 0.08)',
  glassBgActive: 'rgba(255, 255, 255, 0.12)',
  glassBorder: 'rgba(255, 255, 255, 0.10)',

  // Text
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255, 255, 255, 0.60)',
  textTertiary: 'rgba(255, 255, 255, 0.40)',

  // Accent
  accentPrimary: '#e91e8c',
  accentPurple: '#7c3aed',
  accentGreen: '#22c55e',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
} as const;

export const BlurRadius = {
  card: 20,
  player: 30,
  modal: 40,
} as const;

export const Typography = {
  headingXl: { fontSize: 28, fontWeight: '700' as const, lineHeight: 34 },
  headingLg: { fontSize: 22, fontWeight: '700' as const, lineHeight: 29 },
  headingMd: { fontSize: 18, fontWeight: '600' as const, lineHeight: 23 },
  headingSm: { fontSize: 15, fontWeight: '600' as const, lineHeight: 21 },
  body: { fontSize: 14, fontWeight: '400' as const, lineHeight: 21 },
  bodySm: { fontSize: 12, fontWeight: '400' as const, lineHeight: 18 },
  caption: { fontSize: 11, fontWeight: '500' as const, lineHeight: 15 },
  button: { fontSize: 14, fontWeight: '600' as const, lineHeight: 14 },
} as const;

export const Shadows = {
  glass: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.30,
    shadowRadius: 16,
    elevation: 8,
  },
  elevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.20,
    shadowRadius: 8,
    elevation: 4,
  },
  subtle: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
} as const;
