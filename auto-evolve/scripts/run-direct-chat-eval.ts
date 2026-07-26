import path from "node:path"
import { readFile } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile } from "../orchestrator/fs"
import { buildDirectChatDatasetWithAdapter } from "../orchestrator/direct-chat/adapters"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runDirectChatEvaluation } from "../orchestrator/direct-chat/runner"
import type { DirectChatModelsConfig } from "../orchestrator/direct-chat/contract"
import { loadConfig } from "../orchestrator/schema"
import { writeRunManifest } from "../orchestrator/stop-manager"
import { updateExperimentLedger } from "./update-experiment-ledger"

function parseArgs(argv: string[]) {
  const result: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      result[key] = true
    } else {
      result[key] = next
      i += 1
    }
  }
  return result
}

function requireString(args: Record<string, string | boolean>, key: string) {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required --${key}`)
  return value
}

function isSkillInputMode(value: unknown): value is "full" | "head-tail" | "core-files" {
  return value === "full" || value === "head-tail" || value === "core-files"
}

function isOfficeqaMaterialMode(value: unknown): value is "native-pdf" | "skillopt-oracle-json" {
  return value === "native-pdf" || value === "skillopt-oracle-json"
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const autoRoot = path.join(repoRoot, "auto-evolve")
  const projectConfig = await loadConfig(repoRoot)
  const args = parseArgs(process.argv.slice(2))
  const runModeID =
    typeof args["run-mode"] === "string"
      ? args["run-mode"]
      : projectConfig.directChatConfig.defaultRunMode
  const runMode = runModeID ? projectConfig.directChatConfig.runModes?.[runModeID] : undefined
  if (runModeID && !runMode) {
    const available = Object.keys(projectConfig.directChatConfig.runModes || {}).sort().join(", ") || "(none)"
    throw new Error(`Unknown Direct Chat run mode: ${runModeID}. Available modes: ${available}`)
  }
  const outDir = path.resolve(String(args["out-dir"] || path.join(autoRoot, "runtime-state", "direct-chat-runs", new Date().toISOString().replace(/[:.]/g, "-"))))
  await ensureDirectory(outDir)
  await writeRunManifest({
    rootDir: outDir,
    runKind: "direct-chat-eval",
    runID: path.basename(outDir),
    primaryStateFiles: ["config.snapshot.json", "summary.json"],
    artifactRoots: ["results", "summary.json", "results.csv", "stop-reports"],
    resumeCommand: `rerun run-direct-chat-eval with --out-dir "${outDir}" --resume-existing`,
  })

  const skillBundlePath = typeof args["skill-bundle"] === "string"
    ? path.resolve(args["skill-bundle"])
    : (await buildSkillBundle({
        skillRoot: path.resolve(requireString(args, "skill-root")),
        outDir,
      })).bundlePath

  const taskPackRoot = typeof args["task-pack-root"] === "string" ? path.resolve(args["task-pack-root"]) : undefined
  const datasetKind = String(args["dataset-kind"] || projectConfig.directChatConfig.adapterID || "auto")
  const datasetBundlePath = typeof args["dataset-bundle"] === "string"
    ? path.resolve(args["dataset-bundle"])
    : (await buildDirectChatDatasetWithAdapter({
        adapterID: datasetKind,
        taskPackRoot: taskPackRoot || path.resolve(requireString(args, "task-pack-root")),
        splitPath: typeof args.split === "string" ? path.resolve(args.split) : undefined,
        splitName: typeof args["split-name"] === "string" ? args["split-name"] : undefined,
        outDir,
        limit: typeof args.limit === "string" ? Number(args.limit) : undefined,
        allowOmittedMaterials: Boolean(args["allow-omitted-materials"]),
        extractPdfText: !Boolean(args["no-pdf-text"]),
        maxPdfCharsPerFile: typeof args["max-pdf-chars"] === "string" ? Number(args["max-pdf-chars"]) : undefined,
        officeqaMaterialMode: isOfficeqaMaterialMode(args["officeqa-material-mode"])
          ? args["officeqa-material-mode"]
          : runMode?.officeqaMaterialMode || projectConfig.directChatConfig.officeqaMaterialMode,
        officeqaDocsDir:
          typeof args["officeqa-docs-dir"] === "string"
            ? path.resolve(args["officeqa-docs-dir"])
            : projectConfig.directChatConfig.officeqaDocsDir
              ? path.resolve(projectConfig.directChatConfig.officeqaDocsDir)
              : undefined,
      })).bundlePath

  if (!(await pathExists(skillBundlePath))) throw new Error(`Missing skill bundle: ${skillBundlePath}`)
  if (!(await pathExists(datasetBundlePath))) throw new Error(`Missing dataset bundle: ${datasetBundlePath}`)

  if (Boolean(args["prepare-only"]) || Boolean(args["dry-run"])) {
    const rawDataset = await readFile(datasetBundlePath, "utf8")
    const caseCount = rawDataset.split(/\r?\n/g).filter((line) => line.trim()).length
    console.log(`Direct chat preparation finished: ${outDir}`)
    console.log(`Skill bundle: ${skillBundlePath}`)
    console.log(`Dataset bundle: ${datasetBundlePath}`)
    console.log(`Cases: ${caseCount}`)
    return
  }

  const modelsConfigPath = typeof args["models-config"] === "string" ? path.resolve(args["models-config"]) : undefined
  const modelsConfig = modelsConfigPath
    ? await readJsonFile<DirectChatModelsConfig>(modelsConfigPath)
    : projectConfig.directChatConfig
  if (Object.keys(modelsConfig.models || {}).length === 0) {
    throw new Error(
      "No Direct Chat models configured. Add directChatConfig.models to auto-evolve/config.json or pass --models-config.",
    )
  }
  const selectedModelIDs =
    typeof args.models === "string"
      ? args.models.split(",").map((item) => item.trim()).filter(Boolean)
      : projectConfig.directChatConfig.defaultModelIDs.length > 0
        ? projectConfig.directChatConfig.defaultModelIDs
        : undefined
  const selectedCaseIDs = typeof args["case-ids"] === "string"
    ? args["case-ids"].split(",").map((item) => item.trim()).filter(Boolean)
    : undefined
  const globalConcurrency =
    typeof args["global-concurrency"] === "string"
      ? Number(args["global-concurrency"])
      : typeof runMode?.globalConcurrency === "number" && runMode.globalConcurrency > 0
        ? Math.floor(runMode.globalConcurrency)
        : projectConfig.stageConcurrency.testDirectChat
  const skillInputMode = isSkillInputMode(args["skill-input-mode"])
    ? args["skill-input-mode"]
    : isSkillInputMode(runMode?.skillInputMode)
      ? runMode.skillInputMode
      : undefined
  const noSkillOnly =
    Boolean(args["no-skill-only"]) ||
    runMode?.noSkillOnly === true ||
    runMode?.skillMode === "no-skill"
  const includeNoSkillBaseline =
    !noSkillOnly &&
    (Boolean(args["include-no-skill-baseline"]) ||
      Boolean(args["no-skill-baseline"]) ||
      runMode?.includeNoSkillBaseline === true ||
      runMode?.skillMode === "paired" ||
      projectConfig.directChatConfig.includeNoSkillBaseline)
  const allowOmittedMaterials =
    Boolean(args["allow-omitted-materials"]) ||
    runMode?.allowOmittedMaterials === true ||
    projectConfig.directChatConfig.allowOmittedMaterials

  await readFile(skillBundlePath, "utf8")
  const result = await runDirectChatEvaluation({
    skillBundlePath,
    datasetBundlePath,
    outDir,
    models: modelsConfig,
    runModeID,
    runModeDescription: typeof runMode?.description === "string" ? runMode.description : undefined,
    modelIDs: selectedModelIDs,
    caseIDs: selectedCaseIDs,
    globalConcurrency,
    allowOmittedMaterials,
    includeNoSkillBaseline,
    noSkillOnly,
    resumeExisting: Boolean(args["resume-existing"]),
    skillInputMode,
    preflightOnly: Boolean(args["preflight-only"]),
  })
  if (Boolean(args["preflight-only"])) {
    console.log(`Direct chat preflight finished without model requests: ${result.outDir}`)
  } else {
    try {
      await updateExperimentLedger(result.outDir)
    } catch (error) {
      const { writeFile } = await import("node:fs/promises")
      const message = error instanceof Error ? error.stack || error.message : String(error)
      await writeFile(path.join(result.outDir, "experiment-ledger-update-error.log"), `${message}\n`, "utf8").catch(() => undefined)
    }
    console.log(`Direct chat evaluation finished: ${result.outDir}`)
    console.log(`Cases x models: ${result.results.length}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
