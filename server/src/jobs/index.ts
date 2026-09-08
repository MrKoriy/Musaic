import { registerJob } from "./scheduler.js";
import { runArtistGraphJob } from "./artist-graph.js";
import { runTagBackfillJob } from "./tag-backfill.js";
import { runSimilarItemsJob } from "./similar-items.js";
import { logRecommendationQualitySummary } from "./quality-summary.js";
import { trainRanker } from "../reco/ranker.js";
import { runAudioEmbeddingsJob } from "./audio-embeddings.js";
import { runRetentionJob } from "./retention.js";
import { runCoverMigrationJob } from "./cover-migration.js";
import { runReleaseDetectionJob } from "./release-detection.js";
import { runDownloadsEvictionJob } from "./downloads-eviction.js";
import { runLoudnessScanJob } from "./loudness-scan.js";
import { runDbIntegrityJob } from "./db-integrity.js";

let registered = false;

export function registerRecommendationJobs(): void {
  if (registered) return;
  registered = true;
  registerJob({ name: "artist-graph", intervalHours: 24, run: () => runArtistGraphJob() });
  registerJob({ name: "tag-backfill", intervalHours: 24, run: () => runTagBackfillJob() });
  registerJob({ name: "similar-items", intervalHours: 24, run: () => runSimilarItemsJob() });
  registerJob({ name: "quality-summary", intervalHours: 24, run: () => logRecommendationQualitySummary(1) });
  registerJob({ name: "train-ranker", intervalHours: 24, run: () => { trainRanker(); } });
  registerJob({ name: "audio-embeddings", intervalHours: 24, run: () => runAudioEmbeddingsJob() });
  registerJob({ name: "retention", intervalHours: 24, run: () => runRetentionJob() });
  registerJob({ name: "cover-migration", intervalHours: 24, run: () => runCoverMigrationJob() });
  registerJob({ name: "release-detection", intervalHours: 12, run: () => runReleaseDetectionJob() });
  registerJob({ name: "downloads-eviction", intervalHours: 24, run: () => runDownloadsEvictionJob() });
  registerJob({ name: "loudness-scan", intervalHours: 1, run: () => runLoudnessScanJob() });
  registerJob({ name: "db-integrity", intervalHours: 1, run: () => runDbIntegrityJob() });
}
