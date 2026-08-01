export interface TrackIdentityInput {
  artist?: string | null;
  title?: string | null;
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim();
}

const FEATURE_MARKER = /\b(?:feat(?:uring)?|ft|with)\.?\b/iu;
const VARIANT_MARKER_COMPACT = /\b(?:(?:tiktok\s+)?remix(?:ed)?|rework|bootleg|mashup|flip|nightcore|(?:tiktok\s+)?sped\s*up|(?:tiktok\s+)?speed\s*up|(?:(?:ultra|super|mega|very|extreme)\s+)?slowed(?:\s*(?:down|\+?\s*reverb))?|reverb(?:ed)?|bass\s*boosted|pitched?|8d(?:\s*audio)?|karaoke|instrumental|acoustic|live|radio\s*edit|extended|club\s*mix|original\s*mix|vip\s*mix|dj\s*mix|remaster(?:ed)?|demo|mono|stereo|cover|alternate|alternative|version|mix|edit)\b/iu;
const STRONG_VARIANT_MARKER = /\b(?:(?:tiktok\s+)?remix(?:ed)?|rework|bootleg|mashup|flip|nightcore|(?:tiktok\s+)?sped\s*up|(?:tiktok\s+)?speed\s*up|(?:(?:ultra|super|mega|very|extreme)\s+)?slowed(?:\s*(?:down|\+?\s*reverb))?|reverb(?:ed)?|bass\s*boosted|pitched?|8d(?:\s*audio)?|radio\s*edit|extended\s*mix|club\s*mix|original\s*mix|vip\s*mix|dj\s*mix|remaster(?:ed)?|alternate\s*version|alternative\s*version)\b/iu;
// JavaScript's \b is ASCII-only, so Cyrillic roots need their own matcher.
const CYRILLIC_VARIANT_MARKER = /(?:ремикс|микс|бутлег|мешап|ускоренн\p{L}*|замедленн\p{L}*|реверб\p{L}*|караоке|инструментал\p{L}*|акустическ\p{L}*|концертн\p{L}*|лаи\p{L}*|ремастер\p{L}*|кавер|версия)/iu;
const CYRILLIC_STRONG_VARIANT_MARKER = /(?:ремикс|бутлег|мешап|ускоренн\p{L}*|замедленн\p{L}*|реверб\p{L}*|ремастер\p{L}*)/iu;

function variantMarkerIndex(value: string, strong = false): number {
  const latin = value.search(strong ? STRONG_VARIANT_MARKER : VARIANT_MARKER_COMPACT);
  const cyrillic = value.search(strong ? CYRILLIC_STRONG_VARIANT_MARKER : CYRILLIC_VARIANT_MARKER);
  if (latin < 0) return cyrillic;
  if (cyrillic < 0) return latin;
  return Math.min(latin, cyrillic);
}

function hasVariantMarker(value: string): boolean {
  return variantMarkerIndex(value) >= 0;
}

function words(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function normalizeArtistIdentity(value: string | null | undefined): string {
  let artist = normalizedText(value);
  const feature = artist.search(FEATURE_MARKER);
  if (feature > 0) artist = artist.slice(0, feature);

  // Providers join separately credited performers with commas. The first
  // credit is the stable identity; remixers and guests differ by release.
  const firstCredit = artist.split(/\s*[,;/]\s*/u)[0] ?? artist;
  return words(firstCredit);
}

export function normalizeTitleIdentity(value: string | null | undefined): string {
  return words(normalizedText(value));
}

export function baseTrackTitle(value: string | null | undefined): string {
  const original = normalizedText(value);
  if (!original) return "";

  let title = original.replace(/[\[({]([^\])}]+)[\])}]/gu, (whole, descriptor: string) =>
    hasVariantMarker(descriptor) || FEATURE_MARKER.test(descriptor) ? " " : ` ${descriptor} `
  );

  const feature = title.search(FEATURE_MARKER);
  if (feature > 0) title = title.slice(0, feature);

  // "Song — DJ Name Remix" and similar catalogue naming conventions.
  const sections = title.split(/\s+(?:-|–|—|\||•|·)\s+/u);
  const variantSection = sections.findIndex((section, index) =>
    index > 0 && (hasVariantMarker(section) || FEATURE_MARKER.test(section))
  );
  if (variantSection > 0) title = sections.slice(0, variantSection).join(" ");

  // Unbracketed suffixes: "Song Remix", "Song Slowed + Reverb".
  const strongMarker = variantMarkerIndex(title, true);
  if (strongMarker > 0) {
    title = title.slice(0, strongMarker);
  } else {
    const marker = variantMarkerIndex(title);
    const prefixWordCount = marker > 0 ? words(title.slice(0, marker)).split(" ").filter(Boolean).length : 0;
    const suffix = marker > 0 ? title.slice(marker).trim() : "";
    const isPlainVariantSuffix = /^(?:extended|mix|edit|version|live(?:\s+version|\s+(?:at|from)\s+.+)?|acoustic(?:\s+version)?|instrumental(?:\s+version)?|karaoke|demo|mono|stereo|cover)$/iu.test(suffix)
      || /^(?:микс|версия|караоке|инструментал\p{L}*|акустическ\p{L}*|концертн\p{L}*|лаи\p{L}*|кавер)$/iu.test(suffix);
    // Avoid mangling legitimate short titles such as "The Mix" or "Live
    // Forever", and series such as "Mix Chapter Six".
    if (marker > 0 && prefixWordCount >= 2 && isPlainVariantSuffix) title = title.slice(0, marker);
  }

  const normalized = words(title);
  return normalized || normalizeTitleIdentity(value);
}

/** Groups provider copies and alternate mixes of the same underlying song. */
export function songFamilyKey(track: TrackIdentityInput): string {
  return `${normalizeArtistIdentity(track.artist)}::${baseTrackTitle(track.title)}`;
}

/** Prefer the standard recording when both it and an alternate are available. */
export function trackVariantPenalty(title: string | null | undefined): number {
  const normalized = normalizedText(title);
  if (!hasVariantMarker(normalized) || baseTrackTitle(title) === normalizeTitleIdentity(title)) return 0;
  if (/\b(?:sped\s*up|speed\s*up|slowed|nightcore|reverb|bass\s*boosted|pitched?|8d)\b/iu.test(normalized)
    || /(?:ускоренн\p{L}*|замедленн\p{L}*|реверб\p{L}*)/iu.test(normalized)) return 10;
  if (/\b(?:remix|rework|bootleg|mashup|flip|club\s*mix|vip\s*mix|dj\s*mix)\b/iu.test(normalized)
    || /(?:ремикс|бутлег|мешап)/iu.test(normalized)) return 7;
  if (/\b(?:live|acoustic|karaoke|instrumental|cover)\b/iu.test(normalized)
    || /(?:концертн\p{L}*|лаи\p{L}*|акустическ\p{L}*|караоке|инструментал\p{L}*|кавер)/iu.test(normalized)) return 4;
  return 1.5;
}
