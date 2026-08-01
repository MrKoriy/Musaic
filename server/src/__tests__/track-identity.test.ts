import { describe, expect, it } from "bun:test";
import {
  baseTrackTitle,
  songFamilyKey,
  trackVariantPenalty,
} from "../utils/track-identity.js";

describe("track identity", () => {
  it("groups common alternate releases into one song family", () => {
    const original = songFamilyKey({ artist: "Neon Artist", title: "Funk Universo" });
    const variants = [
      "Funk Universo (Slowed + Reverb)",
      "Funk Universo - DJ Nova Remix",
      "Funk Universo Sped Up",
      "Funk Universo Ultra Slowed",
      "Funk Universo TikTok Remix",
      "Funk Universo [Live Version]",
      "Funk Universo (2025 Remaster)",
      "Funk Universo — Extended Mix",
      "Funk Universo (Инструментальная версия)",
    ];

    for (const title of variants) {
      expect(songFamilyKey({ artist: "Neon Artist feat. Guest", title })).toBe(original);
    }
  });

  it("normalizes provider artist credit variations", () => {
    const original = songFamilyKey({ artist: "Main Artist", title: "One Song" });
    expect(songFamilyKey({ artist: "Main Artist, Remix Producer", title: "One Song (Remix)" })).toBe(original);
    expect(songFamilyKey({ artist: "Main Artist ft. Guest", title: "One Song" })).toBe(original);
  });

  it("does not mistake legitimate titles beginning with variant words", () => {
    expect(baseTrackTitle("Live Forever")).toBe("live forever");
    expect(baseTrackTitle("The Mix")).toBe("the mix");
    expect(baseTrackTitle("The Pit Viper Mix Chapter Six")).toBe("the pit viper mix chapter six");
    expect(baseTrackTitle("The Pit Viper Mix Chapter Seven")).toBe("the pit viper mix chapter seven");
    expect(trackVariantPenalty("Live Forever")).toBe(0);
  });

  it("penalizes alternate versions so the standard recording wins ranking", () => {
    expect(trackVariantPenalty("Funk Universo")).toBe(0);
    expect(trackVariantPenalty("Funk Universo Remix")).toBeGreaterThan(0);
    expect(trackVariantPenalty("Funk Universo (Ultra Slowed + Reverb)")).toBeGreaterThan(
      trackVariantPenalty("Funk Universo (Live Version)")
    );
  });
});
