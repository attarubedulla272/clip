import { app } from "./app.js";
import { config } from "./config.js";
import mongoose from "mongoose";
import { Job } from "./models/job.js";
import { User } from "./models/user.js";
import { closeAnalysisQueue } from "./jobs/analysis-queue.js";
import { LocalDiskStorage } from "@clipforge/shared/storage";

await mongoose.connect(config.mongoUri);
console.log(JSON.stringify({ level: "info", event: "mongo.connected" }));
await reconcileActiveAnalysisJobs();
const uploadCleanup = new LocalDiskStorage(config.storageRoot);
await cleanupPartialUploads();
const cleanupInterval = setInterval(() => void cleanupPartialUploads(), 60 * 60 * 1000);
cleanupInterval.unref();
const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", event: "api.listening", port: config.port }));
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "api.shutdown", signal }));
  clearInterval(cleanupInterval);
  server.close(async (error) => {
    if (error) {
      console.error(JSON.stringify({ level: "error", event: "api.close.error", message: error.message }));
      process.exitCode = 1;
    }
    await closeAnalysisQueue();
    await mongoose.disconnect();
  });
}

async function cleanupPartialUploads() {
  try {
    const removed = await uploadCleanup.cleanupExpiredStaging(new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (removed > 0) {
      console.log(JSON.stringify({ level: "info", event: "storage.stale_uploads.cleaned", count: removed }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "storage.stale_uploads.cleanup_failed",
      message: error instanceof Error ? error.message : "Unknown cleanup error"
    }));
  }
}

async function reconcileActiveAnalysisJobs() {
  await User.updateMany({ activeAnalysisJobs: { $exists: false } }, { $set: { activeAnalysisJobs: 0 } });
  const activeByUser = await Job.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { status: { $in: ["queued", "processing"] } } },
    { $group: { _id: "$userId", count: { $sum: 1 } } }
  ]);
  await User.updateMany({}, { $set: { activeAnalysisJobs: 0 } });
  for (const active of activeByUser) {
    await User.updateOne({ _id: active._id }, { $set: { activeAnalysisJobs: active.count } });
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
