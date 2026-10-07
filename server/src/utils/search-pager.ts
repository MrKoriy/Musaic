import crypto from "node:crypto";
import type { Track } from "../types.js";
import { BoundedLRUCache } from "./cache.js";
import { songFamilyKey } from "./track-identity.js";

export type SearchHit = Track & { versions?: Track[] };
export interface SearchPage { tracks: SearchHit[]; hasMore: boolean; nextCursor?: string; errors: Record<string, string> }
type FetchPage = (source: string, offset: number, limit: number) => Promise<Track[]>;
interface State {
  scope: string; sources: string[]; offsets: Record<string, number>; exhausted: Set<string>;
  buffer: SearchHit[]; seen: Set<string>; limit: number; result?: SearchPage;
  pending?: Promise<SearchPage>;
}
/** Immutable continuation tokens: GET retries return the same page, not the next one. */
export class SearchPager {
  private readonly states = new BoundedLRUCache<State>(120);
  private readonly ttl = 5 * 60_000;

  async page(scope: string, sources: string[], limit: number, fetchPage: FetchPage, cursor?: string): Promise<SearchPage | null> {
    const state: State | null = cursor ? this.states.get(cursor) : {
      scope, sources, limit, offsets: Object.fromEntries(sources.map(s => [s, 0])),
      exhausted: new Set(), buffer: [], seen: new Set(),
    };
    if (!state || state.scope !== scope || state.limit !== limit) return null;
    if (state.result) return state.result;
    if (state.pending) return state.pending;
    state.pending = this.advance(state, fetchPage);
    try { state.result = await state.pending; return state.result; }
    finally { state.pending = undefined; }
  }
  private async advance(original: State, fetchPage: FetchPage): Promise<SearchPage> {
    const state: State = { ...original, offsets: { ...original.offsets }, exhausted: new Set(original.exhausted),
      buffer: original.buffer.map(t => ({ ...t })), seen: new Set(original.seen), result: undefined, pending: undefined };
    const errors: Record<string, string> = {};
    // Fill enough for one page. A provider's over-fetch remains buffered for later.
    for (let round = 0; state.buffer.length < state.limit && round < 4; round++) {
      const active = state.sources.filter(s => !state.exhausted.has(s));
      if (!active.length) break;
      const amount = Math.min(100, state.limit + 10);
      const batches = await Promise.all(active.map(async source => {
        try {
          const tracks = await fetchPage(source, state.offsets[source] ?? 0, amount);
          state.offsets[source] = (state.offsets[source] ?? 0) + amount;
          if (tracks.length < amount) state.exhausted.add(source);
          return tracks;
        } catch (error) {
          errors[source] = error instanceof Error ? error.message : String(error);
          state.exhausted.add(source);
          return [];
        }
      }));
      const buffered = new Map(state.buffer.map(t => [songFamilyKey(t), t]));
      for (const track of batches.flat()) {
        const family = songFamilyKey(track);
        const existing = buffered.get(family);
        if (existing) {
          const versions = existing.versions ?? [{ ...existing, versions: undefined }];
          if (!versions.some(v => v.id === track.id)) existing.versions = [...versions, track];
        } else if (!state.seen.has(family)) {
          const hit: SearchHit = { ...track };
          state.buffer.push(hit); buffered.set(family, hit); state.seen.add(family);
        }
      }
    }
    const tracks = state.buffer.splice(0, state.limit);
    const hasMore = state.buffer.length > 0 || state.exhausted.size < state.sources.length;
    const nextCursor = hasMore ? crypto.randomUUID() : undefined;
    if (nextCursor) this.states.set(nextCursor, state, this.ttl);
    return { tracks, hasMore, nextCursor, errors };
  }
}
export const searchPager = new SearchPager();
