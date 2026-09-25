/**
 * Recommendation/provider-domain migrations, kept apart from the core list so
 * the two areas can evolve without editing the same array. Versions 40+ are
 * reserved for this file; core migrations in migrations.ts use 1–39.
 */
import type { Migration } from "./migrations.js";

export const RECO_MIGRATIONS: Migration[] = [];
