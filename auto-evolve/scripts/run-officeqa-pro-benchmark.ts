import path from "node:path"
import { runTaskPackBenchmark } from "./run-benchmark-orchestrator"

const cwd = path.resolve(import.meta.dir, "..", "..")
const root = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")

const outDir = process.env.OFFICEQA_PRO_BENCHMARK_OUT
  ? path.resolve(process.env.OFFICEQA_PRO_BENCHMARK_OUT)
  : path.join(cwd, "auto-evolve", "runtime-state", "officeqa-pro-benchmark", stamp)

const report = await runTaskPackBenchmark({
  label: "officeqa-pro-benchmark",
  taskPackRoot: root,
  trainSplit: process.env.OFFICEQA_PRO_TRAIN_SPLIT
    ? path.resolve(process.env.OFFICEQA_PRO_TRAIN_SPLIT)
    : path.join(root, "splits", "train-20.json"),
  testSplit: process.env.OFFICEQA_PRO_TEST_SPLIT
    ? path.resolve(process.env.OFFICEQA_PRO_TEST_SPLIT)
    : path.join(root, "splits", "test-10.json"),
  outDir,
  concurrency: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_CONCURRENCY ?? "5", 10)),
  mode: process.env.OFFICEQA_PRO_MODE === "campaign-only" ? "campaign-only" : "full-pipeline",
  stopAfter:
    process.env.OFFICEQA_PRO_STOP_AFTER === "training" ||
    process.env.OFFICEQA_PRO_STOP_AFTER === "merge" ||
    process.env.OFFICEQA_PRO_STOP_AFTER === "train-replay" ||
    process.env.OFFICEQA_PRO_STOP_AFTER === "test" ||
    process.env.OFFICEQA_PRO_STOP_AFTER === "baseline"
      ? process.env.OFFICEQA_PRO_STOP_AFTER
      : undefined,
  dryRun: process.env.OFFICEQA_PRO_DRY_RUN === "1",
  reuseVerified: true,
  resumeRunning: process.env.OFFICEQA_PRO_RESUME_RUNNING === "1",
  runMerge: process.env.OFFICEQA_PRO_SKIP_MERGE !== "1",
  runTrainReplay: process.env.OFFICEQA_PRO_SKIP_TRAIN_REPLAY !== "1",
  runTest: process.env.OFFICEQA_PRO_SKIP_TEST !== "1",
  runBaseline: process.env.OFFICEQA_PRO_SKIP_BASELINE !== "1",
  validateRounds: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_VALIDATE_ROUNDS ?? "1", 10)),
  repairAttempts: Math.max(0, Number.parseInt(process.env.OFFICEQA_PRO_REPAIR_ATTEMPTS ?? "3", 10)),
  trainLimit: 20,
  testLimit: 10,
})

console.log(JSON.stringify(report, null, 2))
