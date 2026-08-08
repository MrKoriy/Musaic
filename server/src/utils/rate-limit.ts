export type RateLimitEntry = { count: number; windowStart: number };

export class InMemoryRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(private readonly maxEntries = 10_000) {}

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.entries.get(key);
    if (!current || now - current.windowStart >= windowMs) {
      this.entries.set(key, { count: 1, windowStart: now });
      return true;
    }

    current.count += 1;
    return current.count <= limit;
  }

  cleanup(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= 60 * 60 * 1000) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function requestIp(headers: { header(name: string): string | undefined }): string {
  // Forwarded headers are client-controlled unless the deployment explicitly
  // declares a trusted reverse proxy. A single direct key is safer than an
  // attacker rotating spoofed addresses to bypass the limiter.
  if (process.env.TRUST_PROXY === "1") {
    return headers.header("x-forwarded-for")?.split(",")[0]?.trim()
      || headers.header("x-real-ip")
      || "proxy-client";
  }
  return "direct-client";
}
