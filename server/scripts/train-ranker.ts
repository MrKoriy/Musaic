import { trainRanker } from "../src/reco/ranker.js";
import { getDb } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";

runMigrations(getDb());

const model = trainRanker();
if (!model) {
  console.log("[reco-ranker] not enough labelled impressions to train");
} else {
  console.log(JSON.stringify({
    version: model.version,
    auc: model.auc,
    impressionsUsed: model.impressionsUsed,
  }));
}
