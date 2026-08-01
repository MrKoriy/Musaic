import { describe, it, expect } from "bun:test";
import { artistCreditMatches, artistNameMatches } from "../providers/youtube.js";

/**
 * The artist-name safety net that keeps unrelated YouTube "recommended"
 * tracks out of an artist's card (e.g. "FORTUNA 812" surfacing "Amazwi").
 */
describe("artistNameMatches", () => {
  it("accepts exact and case-insensitive matches", () => {
    expect(artistNameMatches("FORTUNA 812", "FORTUNA 812")).toBe(true);
    expect(artistNameMatches("fortuna 812", "FORTUNA 812")).toBe(true);
  });

  it("rejects completely unrelated artists", () => {
    expect(artistNameMatches("FORTUNA 812", "Amazwi")).toBe(false);
    expect(artistNameMatches("Би-2", "Сплин")).toBe(false);
  });

  it("rejects substring collisions that used to pollute artist cards", () => {
    expect(artistNameMatches("ATL", "Atlas")).toBe(false);
    expect(artistNameMatches("MIA", "Miami Yacine")).toBe(false);
    expect(artistNameMatches("Кино", "Кинопроба")).toBe(false);
    expect(artistNameMatches("Muse", "Museum Sounds")).toBe(false);
  });

  it("accepts collaborations where the artist is part of the credit", () => {
    expect(artistNameMatches("FORTUNA 812", "FORTUNA 812, madk1d")).toBe(true);
    expect(artistNameMatches("FORTUNA 812", "Юпи, FORTUNA 812")).toBe(true);
    expect(artistNameMatches("Imagine Dragons", "Imagine Dragons, JID")).toBe(true);
  });

  it("accepts partial queries that are a subset of the artist name", () => {
    expect(artistNameMatches("fortuna", "FORTUNA 812")).toBe(true);
    expect(artistNameMatches("812", "FORTUNA 812")).toBe(true);
  });

  it("accepts multi-artist queries against each individual artist", () => {
    expect(artistNameMatches("Flo Milli, SZA", "Flo Milli")).toBe(true);
    expect(artistNameMatches("Flo Milli, SZA", "SZA")).toBe(true);
  });

  it("uses stricter ownership rules for tracks on an artist card", () => {
    expect(artistCreditMatches("FORTUNA 812", "FORTUNA 812, madk1d")).toBe(true);
    expect(artistCreditMatches("Flo Milli, SZA", "SZA")).toBe(true);
    expect(artistCreditMatches("MiyaGi & Andy Panda", "Panda")).toBe(false);
    expect(artistCreditMatches("fortuna", "FORTUNA 812")).toBe(false);
  });

  it("ignores stop words and transliteration-stable spelling", () => {
    expect(artistNameMatches("The Weeknd", "Weeknd")).toBe(true);
    expect(artistNameMatches("OXxxymiron", "Oxxxymiron")).toBe(true);
  });

  it("rejects empty inputs", () => {
    expect(artistNameMatches("", "FORTUNA 812")).toBe(false);
    expect(artistNameMatches("FORTUNA 812", "")).toBe(false);
  });
});
