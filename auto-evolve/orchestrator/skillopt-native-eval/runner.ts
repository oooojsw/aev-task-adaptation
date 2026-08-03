import crypto from "node:crypto"
import path from "node:path"
import { cp, mkdir, readFile, readdir } from "node:fs/promises"
import { pathExists, writeJsonFile, writeTextFile } from "../fs"
import { runManagedProcess } from "../managed-process"
import type {
  SkillOptNativeCaseResult,
  SkillOptNativeEvalInput,
  SkillOptNativeEvalResult,
  SkillOptNativeSplit,
} from "./contract"

const SPLIT_DIRECTORY: Record<Exclude<SkillOptNativeSplit, "all">, "train" | "val" | "test"> = {
  train: "train",
  valid_seen: "val",
  valid_unseen: "test",
}

function resolveConfiguredPath(root: string, value: string) {
  if (!value.trim()) return ""
  return path.resolve(path.isAbsolute(value) ? value : path.join(root, value))
}

function normalizeSlash(value: string) {
  return value.replace(/\\/g, "/")
}

function resolveDataDirs(projectRoot: string, values: string[]) {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(path.isAbsolute(value) ? value : path.join(projectRoot, value)))
}

async function resolveTargetCredential(input: SkillOptNativeEvalInput) {
  const authFile = input.config.targetAuthFile.trim()
  if (authFile) {
    const absolute = path.resolve(authFile)
    if (!(await pathExists(absolute))) throw new Error(`opt-direct-chat auth snapshot not found: ${absolute}`)
    const parsed = JSON.parse((await readFile(absolute, "utf8")).replace(/^\uFEFF/, ""))
    const auth = asRecord(parsed)
    const providerID = input.config.targetAuthProviderID.trim()
    if (!providerID) {
      throw new Error("opt-direct-chat targetAuthProviderID is required when targetAuthFile is configured.")
    }
    const provider = asRecord(auth?.[providerID])
    const key = typeof provider?.key === "string" ? provider.key.trim() : ""
    if (!key) {
      throw new Error(`opt-direct-chat provider ${providerID} has no API key in auth snapshot: ${absolute}`)
    }
    return {
      key,
      source: "opencode_auth_snapshot" as const,
      authFile: absolute,
      providerID,
    }
  }

  const envName = input.config.targetApiKeyEnv.trim()
  const key = envName ? process.env[envName]?.trim() : ""
  if (envName && !key) throw new Error(`opt-direct-chat API key environment variable is missing: ${envName}`)
  return {
    key: key || undefined,
    source: key ? ("environment" as const) : ("none" as const),
    authFile: undefined,
    providerID: undefined,
  }
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function itemID(value: unknown) {
  const row = asRecord(value)
  const raw = row?.id ?? row?.uid
  return typeof raw === "string" ? raw.trim() : ""
}

async function firstDataFile(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true })
  const file = entries
    .filter((entry) => entry.isFile() && [".json", ".csv"].includes(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name))[0]
  if (!file) throw new Error(`SkillOpt split directory has no JSON/CSV data file: ${directory}`)
  return path.join(directory, file.name)
}

async function materializeFilteredSplit(input: {
  sourceSplitDir: string
  outputSplitDir: string
  split: SkillOptNativeSplit
  caseIDs?: string[]
}) {
  if (!input.caseIDs?.length || input.split === "all") return input.sourceSplitDir
  const targetName = SPLIT_DIRECTORY[input.split]
  const wanted = new Set(input.caseIDs.map((item) => item.trim()).filter(Boolean))
  const selectedByID = new Map<string, unknown>()
  const sourcePartitionByID = new Map<string, string>()
  await mkdir(input.outputSplitDir, { recursive: true })

  for (const name of ["train", "val", "test"] as const) {
    const sourceDir = path.join(input.sourceSplitDir, name)
    const sourceFile = await firstDataFile(sourceDir)
    if (path.extname(sourceFile).toLowerCase() !== ".json") {
      throw new Error(
        `Filtered opt-direct-chat currently requires JSON split files; received ${sourceFile}. ` +
          "Use the full native split or materialize a JSON id split.",
      )
    }
    const parsed = JSON.parse((await readFile(sourceFile, "utf8")).replace(/^\uFEFF/, ""))
    if (!Array.isArray(parsed)) throw new Error(`SkillOpt split file must contain a JSON array: ${sourceFile}`)
    for (const item of parsed) {
      const id = itemID(item)
      if (!wanted.has(id)) continue
      const previousPartition = sourcePartitionByID.get(id)
      if (previousPartition) {
        throw new Error(
          `SkillOpt split contains duplicate requested case ${id} in ${previousPartition} and ${name}; refusing ambiguous evaluation`,
        )
      }
      selectedByID.set(id, item)
      sourcePartitionByID.set(id, name)
    }
  }

  const missing = [...wanted].filter((id) => !selectedByID.has(id))
  if (missing.length) {
    throw new Error(`SkillOpt split is missing ${missing.length} requested case(s): ${missing.slice(0, 10).join(", ")}`)
  }
  const selected = [...wanted].map((id) => selectedByID.get(id))
  for (const name of ["train", "val", "test"] as const) {
    const targetDir = path.join(input.outputSplitDir, name)
    await mkdir(targetDir, { recursive: true })
    await writeJsonFile(path.join(targetDir, "items.json"), name === targetName ? selected : [])
  }
  const manifestPath = path.join(input.sourceSplitDir, "split_manifest.json")
  if (await pathExists(manifestPath)) {
    await cp(manifestPath, path.join(input.outputSplitDir, "split_manifest.source.json"), { force: true })
  }
  await writeJsonFile(path.join(input.outputSplitDir, "aev-filter-manifest.json"), {
    schema: "auto-evolve/skillopt-filtered-split/v1",
    sourceSplitDir: normalizeSlash(input.sourceSplitDir),
    split: input.split,
    caseIDs: [...wanted],
    sourcePartitions: Object.fromEntries([...sourcePartitionByID.entries()]),
  })
  return input.outputSplitDir
}

async function readJsonl(filePath: string) {
  const text = await readFile(filePath, "utf8")
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown
      } catch (error) {
        throw new Error(`Invalid SkillOpt results.jsonl line ${index + 1}: ${error instanceof Error ? error.message : error}`)
      }
    })
}

function normalizeCaseResult(value: unknown): SkillOptNativeCaseResult {
  const row = asRecord(value) ?? {}
  const id = itemID(row)
  const hard = typeof row.hard === "number" && Number.isFinite(row.hard) ? row.hard : 0
  const soft = typeof row.soft === "number" && Number.isFinite(row.soft) ? row.soft : 0
  return {
    id,
    hard,
    soft,
    passed: hard >= 1,
    failReason: typeof row.fail_reason === "string" && row.fail_reason.trim() ? row.fail_reason.trim() : undefined,
    agentOK: typeof row.agent_ok === "boolean" ? row.agent_ok : undefined,
  }
}

function isInfrastructureCaseFailure(item: SkillOptNativeCaseResult) {
  if (item.agentOK !== false) return false
  const reason = item.failReason?.trim().toLowerCase() ?? ""
  return (
    reason.startsWith("error:") ||
    reason.includes("infrastructure_") ||
    reason.includes("provider") ||
    reason.includes("rate limit") ||
    reason.includes("timed out") ||
    reason.includes("timeout")
  )
}

export async function runSkillOptNativeEval(input: SkillOptNativeEvalInput): Promise<SkillOptNativeEvalResult> {
  const startedAt = Date.now()
  const projectRoot = path.resolve(input.config.projectRoot)
  const scriptPath = path.join(projectRoot, "scripts", "eval_only.py")
  const configPath = resolveConfiguredPath(projectRoot, input.config.configPath)
  const sourceSplitDir = resolveConfiguredPath(projectRoot, input.config.splitDir)
  const dataDirs = resolveDataDirs(projectRoot, input.config.dataDirs)
  const skillPath = path.resolve(input.skillPath)
  const outDir = path.resolve(input.outDir)
  const targetCredential = await resolveTargetCredential(input)
  for (const [label, candidate] of [
    ["SkillOpt project", projectRoot],
    ["SkillOpt eval script", scriptPath],
    ["SkillOpt config", configPath],
    ["SkillOpt split", sourceSplitDir],
    ["skill", skillPath],
  ] as const) {
    if (!candidate || !(await pathExists(candidate))) throw new Error(`${label} not found: ${candidate || "(empty)"}`)
  }
  if (!input.config.enabled) throw new Error("opt-direct-chat is disabled in skillOptDirectChatConfig.")
  await mkdir(outDir, { recursive: true })
  const nativeRunDir = path.join(outDir, "native-output")
  const filteredSplitDir = await materializeFilteredSplit({
    sourceSplitDir,
    outputSplitDir: path.join(outDir, "filtered-split"),
    split: input.split,
    caseIDs: input.caseIDs,
  })
  const skillContent = await readFile(skillPath, "utf8")
  const command = [
    input.config.pythonCommand || "python",
    scriptPath,
    "--config",
    configPath,
    "--skill",
    skillPath,
    "--split",
    input.split,
    "--out_root",
    nativeRunDir,
    "--split_dir",
    filteredSplitDir,
    "--workers",
    String(input.config.workers),
    "--max_api_workers",
    String(input.config.workers),
    "--cfg-options",
    "env.use_local_tools=false",
  ]
  if (dataDirs.length) command.push(`env.data_dirs=${dataDirs.join(path.delimiter)}`)
  if (input.config.targetBackend.trim()) command.push("--target_backend", input.config.targetBackend.trim())
  if (input.config.targetModel.trim()) command.push("--target_model", input.config.targetModel.trim())
  if (input.config.reasoningEffort.trim()) command.push("--reasoning_effort", input.config.reasoningEffort.trim())
  const launch = {
    schema: "auto-evolve/skillopt-native-eval-launch/v1",
    createdAt: new Date().toISOString(),
    projectRoot: normalizeSlash(projectRoot),
    scriptPath: normalizeSlash(scriptPath),
    configPath: normalizeSlash(configPath),
    sourceSplitDir: normalizeSlash(sourceSplitDir),
    effectiveSplitDir: normalizeSlash(filteredSplitDir),
    dataDirs: dataDirs.map(normalizeSlash),
    split: input.split,
    caseIDs: input.caseIDs ?? [],
    skillPath: normalizeSlash(skillPath),
    skillSha256: sha256(skillContent),
    outputDir: normalizeSlash(nativeRunDir),
    targetBackend: input.config.targetBackend,
    targetModel: input.config.targetModel,
    targetBaseUrl: input.config.targetBaseUrl,
    targetCredentialSource: targetCredential.source,
    targetAuthFile: targetCredential.authFile ? normalizeSlash(targetCredential.authFile) : undefined,
    targetAuthProviderID: targetCredential.providerID,
    targetApiKeyEnv: input.config.targetApiKeyEnv,
    reasoningEffort: input.config.reasoningEffort,
    workers: input.config.workers,
    useLocalTools: false,
    sourceMutationPolicy: "read_only_external_project",
  }
  await writeJsonFile(path.join(outDir, "launch.json"), launch)
  const result = await runManagedProcess({
    title: `SkillOpt native Direct Chat ${input.split}`,
    command,
    cwd: projectRoot,
    env: {
      ...input.env,
      ...(input.config.targetBackend === "minimax_chat" && input.config.targetBaseUrl.trim()
        ? { MINIMAX_BASE_URL: input.config.targetBaseUrl.trim() }
        : {}),
      ...(input.config.targetBackend === "minimax_chat" && targetCredential.key
        ? { MINIMAX_API_KEY: targetCredential.key }
        : {}),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeoutMs: input.config.timeoutMs,
    runtimeScope: input.runtimeScope ?? `skillopt-native-eval:${path.basename(outDir)}`,
  })
  await writeTextFile(path.join(outDir, "stdout.log"), result.stdout)
  await writeTextFile(path.join(outDir, "stderr.log"), result.stderr)
  await writeJsonFile(path.join(outDir, "process-result.json"), result)
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `SkillOpt native Direct Chat failed: exit=${result.exitCode}, timedOut=${result.timedOut}. ` +
        `See ${path.join(outDir, "stderr.log")}`,
    )
  }
  const nativeSummaryPath = path.join(nativeRunDir, "eval_summary.json")
  const nativeResultsPath = path.join(nativeRunDir, "results.jsonl")
  if (!(await pathExists(nativeSummaryPath)) || !(await pathExists(nativeResultsPath))) {
    throw new Error(`SkillOpt native Direct Chat completed without eval_summary.json/results.jsonl under ${nativeRunDir}`)
  }
  const summary = JSON.parse((await readFile(nativeSummaryPath, "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>
  const cases = (await readJsonl(nativeResultsPath)).map(normalizeCaseResult)
  const requested = input.caseIDs?.length
    ? new Set(input.caseIDs.map((item) => item.trim()).filter(Boolean))
    : undefined
  const duplicateIDs = cases.map((item) => item.id).filter((id, index, all) => id && all.indexOf(id) !== index)
  if (duplicateIDs.length) throw new Error(`SkillOpt returned duplicate case IDs: ${[...new Set(duplicateIDs)].join(", ")}`)
  if (requested) {
    const returned = new Set(cases.map((item) => item.id))
    const missing = [...requested].filter((id) => !returned.has(id))
    if (missing.length) throw new Error(`SkillOpt returned no result for: ${missing.slice(0, 10).join(", ")}`)
    const unexpected = [...returned].filter((id) => !requested.has(id))
    if (unexpected.length) {
      throw new Error(`SkillOpt returned unexpected case IDs: ${unexpected.slice(0, 10).join(", ")}`)
    }
  }
  const nativeItemCount =
    typeof summary.n_items === "number"
      ? summary.n_items
      : typeof summary.total === "number"
        ? summary.total
        : undefined
  if (nativeItemCount !== undefined && nativeItemCount !== cases.length) {
    throw new Error(
      `SkillOpt summary/results count mismatch: summary=${nativeItemCount}, results=${cases.length}`,
    )
  }
  const infrastructureFailures = cases.filter(isInfrastructureCaseFailure)
  if (infrastructureFailures.length) {
    const preview = infrastructureFailures
      .slice(0, 5)
      .map((item) => `${item.id}: ${item.failReason || "agent_ok=false"}`)
      .join("; ")
    throw new Error(
      `SkillOpt native Direct Chat returned ${infrastructureFailures.length}/${cases.length} infrastructure-failed case(s); ` +
        `refusing to treat them as product regressions or start skill repair. ${preview}`,
    )
  }
  const passed = cases.filter((item) => item.passed).length
  const output: SkillOptNativeEvalResult = {
    schema: "auto-evolve/skillopt-native-eval-result/v1",
    passed,
    total: cases.length,
    failed: cases.length - passed,
    skipped: 0,
    hard: typeof summary.hard === "number" ? summary.hard : cases.length ? passed / cases.length : 0,
    soft:
      typeof summary.soft === "number"
        ? summary.soft
        : cases.length
          ? cases.reduce((sum, item) => sum + item.soft, 0) / cases.length
          : 0,
    regressions: cases.filter((item) => !item.passed).map((item) => item.id),
    durationMs: Date.now() - startedAt,
    nativeRunDir,
    nativeSummaryPath,
    nativeResultsPath,
    cases,
  }
  await writeJsonFile(path.join(outDir, "result.json"), output)
  return output
}
