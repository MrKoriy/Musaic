export const CANONICAL_TAG_ALIASES: Record<string, string[]> = {
  pop: ["pop", "popular"],
  rock: ["rock", "alternative rock", "classic rock", "hard rock"],
  indie: ["indie", "indie pop", "indie rock"],
  electronic: ["electronic", "electronica", "electro"],
  dance: ["dance", "dance pop", "club"],
  house: ["house", "deep house", "electro house"],
  techno: ["techno", "minimal techno"],
  trance: ["trance", "psytrance", "psy trance"],
  "drum and bass": ["drum and bass", "drum n bass", "dnb", "d&b"],
  ambient: ["ambient", "dark ambient", "space ambient"],
  chillout: ["chillout", "chill out", "downtempo", "chill"],
  lofi: ["lofi", "lo-fi", "lo fi", "lo\u2011fi"],
  jazz: ["jazz", "smooth jazz", "nu jazz"],
  blues: ["blues", "delta blues"],
  soul: ["soul", "neo-soul", "neo soul"],
  funk: ["funk", "p-funk", "p funk"],
  "r&b": ["r&b", "rnb", "rhythm and blues", "contemporary r&b"],
  hiphop: ["hip-hop", "hip hop", "hiphop"],
  rap: ["rap", "hardcore rap", "underground rap"],
  "russian rap": ["russian rap", "russian hip-hop", "русский рэп", "russian hip hop"],
  trap: ["trap", "cloud rap"],
  drill: ["drill", "uk drill", "chicago drill"],
  metal: ["metal", "heavy metal", "alternative metal"],
  punk: ["punk", "punk rock", "post-punk"],
  emo: ["emo", "emocore", "emo rock"],
  country: ["country", "alt-country"],
  classical: ["classical", "modern classical", "neoclassical"],
  acoustic: ["acoustic", "unplugged"],
  instrumental: ["instrumental", "instrumental music"],
  piano: ["piano", "solo piano"],
  soundtrack: ["soundtrack", "film score", "ost"],
  reggae: ["reggae", "dancehall"],
  latin: ["latin", "latino", "reggaeton"],
  kpop: ["k-pop", "kpop", "k pop"],
  folk: ["folk", "indie folk", "singer-songwriter"],
  happy: ["happy", "feel good", "feelgood", "positive"],
  sad: ["sad", "melancholy", "melancholic", "depressive"],
  romantic: ["romantic", "romance", "love"],
  energetic: ["energetic", "energy", "workout", "gym", "power"],
  relaxing: ["relax", "relaxing", "calm", "sleep", "meditation"],
  focus: ["focus", "study", "concentration", "deep work"],
  night: ["night", "late night", "midnight", "afterhours"],
};

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(CANONICAL_TAG_ALIASES)) {
  for (const alias of [canonical, ...aliases]) {
    ALIAS_TO_CANONICAL.set(normalizeTag(alias), canonical);
  }
}

export function normalizeTag(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeTag(value: string | null | undefined): string | null {
  const normalized = normalizeTag(value);
  if (!normalized) return null;
  return ALIAS_TO_CANONICAL.get(normalized) ?? null;
}

export function canonicalizeTags(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(canonicalizeTag).filter((value): value is string => Boolean(value)))];
}

export function tagWeight(count: number): number {
  return Math.max(0.05, Math.min(1, Number.isFinite(count) ? count / 100 : 0.05));
}
