import { registerJob } from "./scheduler.js";
import { runArtistGraphJob } from "./artist-graph.js";
import { runTagBackfillJob } from "./tag-backfill.js";
import { runSimilarItemsJob } from "./similar-items.js";
import { logRecommendationQualitySummary } from "./quality-summary.js";
import { trainRanker } from "../reco/ranker.js";
import { runAudioEmbeddingsJob } from "./audio-embeddings.js";

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
}
