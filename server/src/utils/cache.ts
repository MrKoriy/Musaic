export const DEFAULT_CACHE_MAX_ENTRIES = 2_000;
export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Small TTL-aware LRU cache used by recommendation and provider helpers. */
export class BoundedLRUCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(public readonly maxEntries = DEFAULT_CACHE_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Cache maxEntries must be a positive integer");
    }
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }

    // Map insertion order is the LRU order. Refresh the key on every hit.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs = DEFAULT_CACHE_TTL_MS): void {
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : DEFAULT_CACHE_TTL_MS;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttl });
    this.evict();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.entries.keys()) {
      if (predicate(key)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.removeExpired();
    return this.entries.size;
  }

  keys(): string[] {
    this.removeExpired();
    return [...this.entries.keys()];
  }

  private evict(): void {
    this.removeExpired();
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

export { BoundedLRUCache as LRUCache };
export const MAX_CACHE_ENTRIES = DEFAULT_CACHE_MAX_ENTRIES;

const configuredCacheMax = Number(process.env.RECOMMENDATION_CACHE_MAX_ENTRIES ?? DEFAULT_CACHE_MAX_ENTRIES);
const sharedCache = new BoundedLRUCache<unknown>(
  Number.isInteger(configuredCacheMax) && configuredCacheMax > 0
    ? configuredCacheMax
    : DEFAULT_CACHE_MAX_ENTRIES,
);
const inFlight = new Map<string, Promise<unknown>>();

export function getCached<T>(key: string): T | null {
  return sharedCache.get(key) as T | null;
}

export function setCached(key: string, value: unknown, ttlMs = DEFAULT_CACHE_TTL_MS): void {
  sharedCache.set(key, value, ttlMs);
}

export function clearCached(key: string): void {
  sharedCache.delete(key);
}

export function clearCachedWhere(predicate: (key: string) => boolean): void {
  sharedCache.deleteWhere(predicate);
}

export function getCacheSize(): number {
  return sharedCache.size;
}

export function getInFlightSize(): number {
  return inFlight.size;
}

/** Return one promise for concurrent work with the same key. */
export function getOrSetCached<T>(
  key: string,
  factory: () => Promise<T> | T,
  ttlMs = DEFAULT_CACHE_TTL_MS,
): Promise<T> {
  const cached = getCached<T>(key);
  if (cached !== null) return Promise.resolve(cached);

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const work = Promise.resolve()
    .then(factory)
    .then((value) => {
      setCached(key, value, ttlMs);
      return value;
    });
  inFlight.set(key, work);
  void work.finally(() => {
    if (inFlight.get(key) === work) inFlight.delete(key);
  }).catch(() => undefined);
  return work;
}

/** Share an in-flight operation without caching its result. */
export function getOrCreateInFlight<T>(key: string, factory: () => Promise<T> | T): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const work = Promise.resolve().then(factory);
  inFlight.set(key, work);
  void work.finally(() => {
    if (inFlight.get(key) === work) inFlight.delete(key);
  }).catch(() => undefined);
  return work;
}

export function clearInFlightWhere(predicate: (key: string) => boolean): void {
  for (const key of inFlight.keys()) {
    if (predicate(key)) inFlight.delete(key);
  }
}

/** Clear both completed values and deduplicated work. */
export function invalidateAllCaches(): void {
  sharedCache.clear();
  inFlight.clear();
}

const cleanupTimer = setInterval(() => {
  // `size` performs expiry cleanup without exposing the underlying map.
  void sharedCache.size;
}, 60_000);
cleanupTimer.unref?.();
