import path from "node:path"
import { runTaskPackBenchmark } from "./run-benchmark-orchestrator"
import { loadConfig } from "../orchestrator/schema"
import type {
  HierarchicalMergeFailurePolicy,
  HierarchicalMergeGrouping,
  HierarchicalMergeInputFilter,
  HierarchicalReplayLevels,
} from "../orchestrator/multi-instance/hierarchical-merger"

const cwd = path.resolve(import.meta.dir, "..", "..")
const root = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "officeqa-pro-learnbench")

function envChoice<T extends string>(raw: string | undefined, fallback: T, aliases: Record<string, T>) {
  const key = (raw ?? fallback).trim().toLowerCase().replace(/-/g, "_")
  return aliases[key] ?? fallback
}

async function main() {
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const mergeStrategy = envChoice<"flat" | "hierarchical">(process.env.OFFICEQA_PRO_MERGE_STRATEGY, "flat", {
  flat: "flat",
  hierarchical: "hierarchical",
  tree: "hierarchical",
})

const hierarchicalReplayLevels = envChoice<HierarchicalReplayLevels>(
  process.env.OFFICEQA_PRO_HIERARCHICAL_LOCAL_REPLAY,
  "none",
  {
    none: "none",
    off: "none",
    false: "none",
    level1: "level1",
    level_1: "level1",
    first: "level1",
    all: "all",
  },
)

const outDir = process.env.OFFICEQA_PRO_BENCHMARK_OUT
  ? path.resolve(process.env.OFFICEQA_PRO_BENCHMARK_OUT)
  : path.join(cwd, "auto-evolve", "runtime-state", "officeqa-pro-benchmark", stamp)
const projectConfig = await loadConfig(cwd)
const stageConcurrency = {
  training: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_TRAIN_CONCURRENCY ?? process.env.OFFICEQA_PRO_CONCURRENCY ?? String(projectConfig.stageConcurrency.training), 10)),
  merge: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_MERGE_CONCURRENCY ?? String(projectConfig.stageConcurrency.merge), 10)),
  hierarchicalMerge: Math.max(
    1,
    Number.parseInt(
      process.env.OFFICEQA_PRO_HIERARCHICAL_MERGE_CONCURRENCY ??
        process.env.OFFICEQA_PRO_MERGE_GROUP_CONCURRENCY ??
        String(projectConfig.stageConcurrency.hierarchicalMerge),
      10,
    ),
  ),
  trainReplay: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_REPLAY_CONCURRENCY ?? String(projectConfig.stageConcurrency.trainReplay), 10)),
  testBlank: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_TEST_CONCURRENCY ?? String(projectConfig.stageConcurrency.testBlank), 10)),
  testDirectChat: Math.max(
    1,
    Number.parseInt(process.env.OFFICEQA_PRO_DIRECT_CHAT_CONCURRENCY ?? String(projectConfig.stageConcurrency.testDirectChat), 10),
  ),
  baseline: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_BASELINE_CONCURRENCY ?? String(projectConfig.stageConcurrency.baseline), 10)),
}

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
  concurrency: stageConcurrency.training,
  stageConcurrency,
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
  mergeStrategy,
  hierarchicalMerge: {
    groupSize: Math.max(2, Number.parseInt(process.env.OFFICEQA_PRO_MERGE_GROUP_SIZE ?? "5", 10)),
    inputFilter: envChoice<HierarchicalMergeInputFilter>(process.env.OFFICEQA_PRO_MERGE_INPUT, "success_only", {
      success: "success_only",
      success_only: "success_only",
      verified: "success_only",
      verified_only: "success_only",
      failed: "failed_only",
      failure: "failed_only",
      failures: "failed_only",
      failed_only: "failed_only",
      all: "all",
    }),
    failurePolicy: envChoice<HierarchicalMergeFailurePolicy>(
      process.env.OFFICEQA_PRO_FAILURE_POLICY,
      "negative_evidence",
      {
        exclude: "exclude",
        negative: "negative_evidence",
        negative_evidence: "negative_evidence",
        diagnostic: "diagnostic_only",
        diagnostic_only: "diagnostic_only",
      },
    ),
    grouping: envChoice<HierarchicalMergeGrouping>(process.env.OFFICEQA_PRO_MERGE_GROUPING, "status_balanced", {
      sequential: "sequential",
      status_balanced: "status_balanced",
      balanced: "status_balanced",
    }),
    localReplay: {
      enabled: hierarchicalReplayLevels !== "none",
      levels: hierarchicalReplayLevels,
      repairOnFailure: process.env.OFFICEQA_PRO_HIERARCHICAL_NO_REPAIR !== "1",
      repairAttemptsPerCase: Math.max(0, Number.parseInt(process.env.OFFICEQA_PRO_HIERARCHICAL_REPAIR_ATTEMPTS ?? "1", 10)),
      rerunAfterRepair: process.env.OFFICEQA_PRO_HIERARCHICAL_RERUN_AFTER_REPAIR === "1",
    },
  },
  runTrainReplay: process.env.OFFICEQA_PRO_SKIP_TRAIN_REPLAY !== "1",
  runTest: process.env.OFFICEQA_PRO_SKIP_TEST !== "1",
  evalRunner: "blank-opencode",
  runBaseline: process.env.OFFICEQA_PRO_SKIP_BASELINE !== "1",
  continueAfterTrainingIncomplete:
    process.env.OFFICEQA_PRO_CONTINUE_AFTER_TRAINING_INCOMPLETE === "1" ||
    process.env.OFFICEQA_PRO_CONTINUE_AFTER_ROUND_LIMIT === "1",
  trainReplayScope:
    process.env.OFFICEQA_PRO_TRAIN_REPLAY_SCOPE === "all" ||
    process.env.OFFICEQA_PRO_TRAIN_REPLAY_SCOPE === "all-train"
      ? "all-train"
      : "verified-only",
  replayConcurrency: stageConcurrency.trainReplay,
  testConcurrency: stageConcurrency.testBlank,
  baselineConcurrency: stageConcurrency.baseline,
  historyPolicy:
    process.env.OFFICEQA_PRO_HISTORY_POLICY === "fresh-non-verified" ||
    process.env.OFFICEQA_PRO_HISTORY_POLICY === "fresh-all" ||
    process.env.OFFICEQA_PRO_HISTORY_POLICY === "resume-explicit-only" ||
    process.env.OFFICEQA_PRO_HISTORY_POLICY === "audit-only"
      ? process.env.OFFICEQA_PRO_HISTORY_POLICY
      : "resume-current-generation",
  continueAfterTrainReplayFailure:
    process.env.OFFICEQA_PRO_CONTINUE_AFTER_TRAIN_REPLAY_FAILURE === "1" ||
    process.env.OFFICEQA_PRO_CONTINUE_AFTER_TRAINING_INCOMPLETE === "1" ||
    process.env.OFFICEQA_PRO_CONTINUE_AFTER_ROUND_LIMIT === "1",
  validateRounds: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_VALIDATE_ROUNDS ?? "1", 10)),
  repairAttempts: Math.max(0, Number.parseInt(process.env.OFFICEQA_PRO_REPAIR_ATTEMPTS ?? "3", 10)),
  trainLimit: Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_TRAIN_LIMIT ?? "20", 10)),
  testLimit: 10,
})

console.log(JSON.stringify(report, null, 2))
}

if (import.meta.main && !process.execArgv.includes("--check")) {
  await main()
}
