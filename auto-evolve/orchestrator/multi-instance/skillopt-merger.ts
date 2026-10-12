import path from "node:path"
import { runBridgeProcess } from "./bridge-process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type { LoadedMergeAsSkillOptConfig } from "../schema"

const FILE_START = "<!-- AEV_SKILL_FILE_START "
const FILE_END = "<!-- AEV_SKILL_FILE_END -->"
const PACKAGE_SCHEMA = "auto-evolve/skill-package-text/v1"

export interface SkillOptSourceSkill {
  id: string
  skillRoot: string
}

export interface SkillOptBridgeRequest {
  schema: "auto-evolve/skillopt-merge-request/v1"
  skillContent: string
  failurePatches: unknown[]
  successPatches: Array<{
    reasoning: string
    skill_candidates: Array<{
      title: string
      change_summary: string[]
      new_skill: string
      support_count: number
      source_type: "success"
    }>
  }>
  batchSize: number
  workers: number
  updateMode: "full_rewrite_minibatch"
  metaSkillContext: string
  skillOptConfigPath: string
  optimizer: {
    backend?: string
    model?: string
    baseUrl?: string
    apiKeyEnv?: string
    reasoningEffort?: string
  }
  lengthPolicy: {
    enabled: boolean
    maxBytes: number
    maxRepairAttempts: number
    unit: "utf8_bytes"
  }
  nativeTrain?: {
    enabled: boolean
    configPath: string
    splitDir?: string
    dataDirs?: string[]
    outRoot: string
    epochs: number
    batchSize: number
    maxSteps: number
    evalTest: boolean
    targetWorkers: number
    targetBackend?: string
    targetModel?: string
    targetBaseUrl?: string
    targetApiKeyEnv?: string
  }
}

export interface SkillOptBridgeResult {
  schema: "auto-evolve/skillopt-merge-result/v1"
  passed: boolean
  reasoning?: string
  mergedSkill?: string
  tokenSummary?: unknown
  warmStartSkill?: string
  nativeTrainSummary?: unknown
  nativeTrainOutRoot?: string
  nativeTrainPreflight?: unknown
  lengthGate?: unknown
  error?: string
}

export type SkillOptBridgeRunner = (input: {
  request: SkillOptBridgeRequest
  requestPath: string
  resultPath: string
  runRoot: string
}) => Promise<SkillOptBridgeResult>

export interface RunSkillOptMergerInput {
  cwd: string
  runRoot: string
  config: LoadedMergeAsSkillOptConfig
  sourceSkills: SkillOptSourceSkill[]
  bridgeRunner?: SkillOptBridgeRunner
}

export interface SkillOptMergerOutcome {
  mergedSkillDir: string
  contributingInstances: string[]
  mergerRunDir: string
  inputManifestPath: string
  reportPath: string
  tokenSummary?: unknown
}

function normalizeSlash(value: string) {
  return value.replace(/\\/g, "/")
}

function resolveConfiguredPath(base: string, value: string) {
  if (!value.trim()) return ""
  return path.resolve(path.isAbsolute(value) ? value : path.join(base, value))
}

function assertSafeRelativePath(input: string) {
  const normalized = normalizeSlash(input).replace(/^\.\//, "")
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`Skill package contains an absolute or empty path: ${input}`)
  }
  const segments = normalized.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error(`Skill package contains an unsafe path segment: ${input}`)
  }
  return normalized
}

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return
  throw new Error(`Refusing to materialize a skill file outside the output root: ${target}`)
}

async function collectSkillFiles(root: string) {
  const resolvedRoot = path.resolve(root)
  const rootStat = await lstat(resolvedRoot)
  if (!rootStat.isDirectory()) throw new Error(`Skill root is not a directory: ${resolvedRoot}`)
  if (rootStat.isSymbolicLink()) throw new Error(`Skill root cannot be a symlink: ${resolvedRoot}`)

  const files: Array<{ path: string; content: string }> = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  async function walk(current: string, relativeRoot: string) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"))
    for (const entry of entries) {
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
      const safeRelative = assertSafeRelativePath(relative)
      const target = path.join(resolvedRoot, ...safeRelative.split("/"))
      assertInside(resolvedRoot, target)
      const info = await lstat(target)
      if (info.isSymbolicLink()) throw new Error(`Skill package cannot contain symlinks: ${target}`)
      if (info.isDirectory()) {
        await walk(target, safeRelative)
        continue
      }
      if (!info.isFile()) throw new Error(`Skill package contains an unsupported filesystem entry: ${target}`)
      const bytes = await readFile(target)
      if (bytes.includes(0)) throw new Error(`Skill package contains a binary file that SkillOpt cannot merge: ${target}`)
      let content: string
      try {
        content = decoder.decode(bytes)
      } catch {
        throw new Error(`Skill package file is not valid UTF-8 text: ${target}`)
      }
      if (content.includes(FILE_START) || content.includes(FILE_END)) {
        throw new Error(`Skill package file collides with the package boundary protocol: ${target}`)
      }
      files.push({ path: safeRelative, content })
    }
  }
  await walk(resolvedRoot, "")
  if (!files.length) throw new Error(`Skill root contains no files: ${resolvedRoot}`)
  return files
}

export async function encodeSkillDirectory(root: string) {
  const files = await collectSkillFiles(root)
  return files
    .map((file) => `${FILE_START}${JSON.stringify(file.path)} -->\n${file.content}\n${FILE_END}`)
    .join("\n")
}

export function decodeSkillPackage(input: string) {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim()
  const lines = normalized.split("\n")
  const files: Array<{ path: string; content: string }> = []
  const seen = new Set<string>()
  let index = 0
  while (index < lines.length) {
    if (!lines[index]!.startsWith(FILE_START) || !lines[index]!.endsWith(" -->")) {
      throw new Error(`SkillOpt output contains text outside the AEV file boundary at line ${index + 1}`)
    }
    const rawPath = lines[index]!.slice(FILE_START.length, -4)
    let decodedPath: unknown
    try {
      decodedPath = JSON.parse(rawPath)
    } catch {
      throw new Error(`SkillOpt output contains an invalid encoded file path at line ${index + 1}`)
    }
    if (typeof decodedPath !== "string") throw new Error(`SkillOpt output file path must be a string at line ${index + 1}`)
    const safePath = assertSafeRelativePath(decodedPath)
    const key = safePath.toLowerCase()
    if (seen.has(key)) throw new Error(`SkillOpt output contains a duplicate file path: ${safePath}`)
    seen.add(key)
    index += 1
    const content: string[] = []
    while (index < lines.length && lines[index] !== FILE_END) {
      content.push(lines[index]!)
      index += 1
    }
    if (index >= lines.length) throw new Error(`SkillOpt output is missing an end boundary for: ${safePath}`)
    files.push({ path: safePath, content: content.join("\n").replace(/\n$/, "") })
    index += 1
  }
  if (!files.length) throw new Error("SkillOpt output did not contain any AEV skill files")
  return files
}

async function materializeSkillPackage(input: string, outputRoot: string) {
  const files = decodeSkillPackage(input)
  await ensureDirectory(outputRoot)
  for (const file of files) {
    const target = path.join(outputRoot, ...file.path.split("/"))
    assertInside(outputRoot, target)
    await ensureDirectory(path.dirname(target))
    await writeTextFile(target, file.content.endsWith("\n") ? file.content : `${file.content}\n`)
  }
  return files.map((file) => file.path)
}

async function defaultBridgeRunner(input: {
  request: SkillOptBridgeRequest
  requestPath: string
  resultPath: string
  runRoot: string
  pythonCommand: string
  bridgeScript: string
  projectRoot: string
  timeoutMs: number
}) {
  const { exitCode, timedOut, stdout, stderr } = await runBridgeProcess({
    command: [
      input.pythonCommand,
      input.bridgeScript,
      "--skillopt-root",
      input.projectRoot,
      "--request",
      input.requestPath,
      "--result",
      input.resultPath,
    ], cwd: input.projectRoot, timeoutMs: input.timeoutMs,
  })
  await writeTextFile(path.join(input.runRoot, "stdout.log"), stdout)
  await writeTextFile(path.join(input.runRoot, "stderr.log"), stderr)
  if (timedOut) throw new Error(`SkillOpt merge timed out after ${input.timeoutMs}ms`)
  if (exitCode !== 0) throw new Error(`SkillOpt merge bridge exited with code ${exitCode}: ${stderr.slice(-2000)}`)
  if (!(await pathExists(input.resultPath))) throw new Error("SkillOpt merge bridge did not write its result JSON")
  return await readJsonFile<SkillOptBridgeResult>(input.resultPath, { validatePaths: false })
}

export async function runSkillOptMerger(input: RunSkillOptMergerInput): Promise<SkillOptMergerOutcome> {
  if (!input.sourceSkills.length) throw new Error("merge-as-opt requires at least one verified source skill")
  if (!Number.isInteger(input.config.batchSize) || input.config.batchSize < 2) {
    throw new Error("merge-as-opt requires batchSize >= 2 so every hierarchy level makes progress")
  }
  if (!Number.isInteger(input.config.workers) || input.config.workers < 1) {
    throw new Error("merge-as-opt requires workers >= 1")
  }
  const sourceIDs = new Set<string>()
  for (const source of input.sourceSkills) {
    const id = source.id.trim()
    if (!id) throw new Error("merge-as-opt source skill IDs cannot be empty")
    const key = id.toLowerCase()
    if (sourceIDs.has(key)) throw new Error(`merge-as-opt source skill ID is duplicated: ${id}`)
    sourceIDs.add(key)
  }
  const mergerRunDir = path.resolve(input.runRoot)
  await ensureDirectory(mergerRunDir)
  const outputRoot = path.join(mergerRunDir, `output-${randomUUID()}`)
  const reportPath = path.join(mergerRunDir, "report.json")
  const inputManifestPath = path.join(mergerRunDir, "input-manifest.json")

  const projectRoot = resolveConfiguredPath(input.cwd, input.config.projectRoot || process.env.SKILLOPT_ROOT || "")
  if (!projectRoot || !(await pathExists(projectRoot))) {
    throw new Error("merge-as-opt requires mergeConfig.asSkillOpt.projectRoot or SKILLOPT_ROOT pointing to a SkillOpt checkout")
  }
  const configPath = resolveConfiguredPath(projectRoot, input.config.configPath)
  if (!configPath || !(await pathExists(configPath))) {
    throw new Error("merge-as-opt requires an existing mergeConfig.asSkillOpt.configPath")
  }
  const nativeTrainConfigPath = input.config.pipelineMode === "native_train"
    ? resolveConfiguredPath(projectRoot, input.config.nativeTrainConfigPath || input.config.configPath)
    : ""
  if (input.config.pipelineMode === "native_train" && (!nativeTrainConfigPath || !(await pathExists(nativeTrainConfigPath)))) {
    throw new Error("merge-as-opt native_train requires an existing nativeTrainConfigPath")
  }
  const externalOutputRoot = input.config.outputRoot.trim()
    ? resolveConfiguredPath(input.cwd, input.config.outputRoot)
    : ""
  const runFingerprint = createHash("sha256").update(normalizeSlash(mergerRunDir)).digest("hex").slice(0, 12)
  const nativeTrainOutRoot = externalOutputRoot
    ? path.join(externalOutputRoot, `${path.basename(mergerRunDir)}-${runFingerprint}`, "native-train")
    : path.join(mergerRunDir, "native-train")
  const bridgeScript = resolveConfiguredPath(path.join(input.cwd, "auto-evolve"), input.config.bridgeScript)
  if (!input.bridgeRunner && (!(await pathExists(bridgeScript)) || !input.config.pythonCommand.trim())) {
    throw new Error(`merge-as-opt bridge preflight failed: ${bridgeScript}`)
  }

  const sourcePackages = [] as Array<{ id: string; skillRoot: string; packageText: string }>
  for (const source of input.sourceSkills) {
    const skillRoot = path.resolve(source.skillRoot)
    sourcePackages.push({ id: source.id, skillRoot, packageText: await encodeSkillDirectory(skillRoot) })
  }
  const initialSkill = input.config.initialSkillPath.trim()
    ? await encodeSkillDirectory(resolveConfiguredPath(input.cwd, input.config.initialSkillPath))
    : `${FILE_START}${JSON.stringify("CORE.md")} -->\n# Merged Skill\n\nConsolidate the verified source skills without task-specific answers.\n${FILE_END}`

  const manifest = {
    schema: "auto-evolve/skillopt-merge-input-manifest/v1",
    createdAt: new Date().toISOString(),
    packageSchema: PACKAGE_SCHEMA,
    sourceSkills: sourcePackages.map((item) => ({ id: item.id, skillRoot: item.skillRoot })),
    skillOpt: {
      projectRoot,
      outputRoot: externalOutputRoot || undefined,
      configPath,
      batchSize: input.config.batchSize,
      workers: input.config.workers,
      optimizerBackend: input.config.optimizerBackend || undefined,
      optimizerModel: input.config.optimizerModel || undefined,
      optimizerBaseUrl: input.config.optimizerBaseUrl || undefined,
      optimizerApiKeyEnv: input.config.optimizerApiKeyEnv || undefined,
      reasoningEffort: input.config.reasoningEffort || undefined,
      maxSkillBytes: input.config.maxSkillBytes,
      lengthRepairAttempts: input.config.lengthRepairAttempts,
      pipelineMode: input.config.pipelineMode,
      nativeTrainConfigPath: nativeTrainConfigPath || undefined,
      nativeTrainSplitDir: input.config.nativeTrainSplitDir || undefined,
      nativeTrainDataDirs: input.config.nativeTrainDataDirs,
      nativeTrainEpochs: input.config.nativeTrainEpochs,
      nativeTrainBatchSize: input.config.nativeTrainBatchSize,
      nativeTrainMaxSteps: input.config.nativeTrainMaxSteps,
      nativeTrainEvalTest: input.config.nativeTrainEvalTest,
      nativeTrainTargetWorkers: input.config.nativeTrainTargetWorkers,
      targetBackend: input.config.targetBackend || undefined,
      targetModel: input.config.targetModel || undefined,
      targetBaseUrl: input.config.targetBaseUrl || undefined,
      targetApiKeyEnv: input.config.targetApiKeyEnv || undefined,
    },
  }
  await writeJsonFile(inputManifestPath, manifest)

  const protocolInstruction = [
    "Every new_skill is a complete AEV multi-file skill package.",
    `Each file starts with ${FILE_START}<JSON relative path> --> and ends with ${FILE_END}.`,
    "Return exactly one complete package in new_skill, with no prose outside file boundaries.",
    "Preserve useful relative filenames and file types; never emit absolute paths, dot segments, hidden paths, or duplicate paths.",
    "The source candidates are verified skills, not trajectories. Merge their reusable methods and remove case-specific answers or identifiers.",
    input.config.maxSkillBytes > 0
      ? `The final merged new_skill must be one coherent deduplicated package within ${input.config.maxSkillBytes} UTF-8 bytes. This is a hard limit, not a soft target.`
      : "The final merged new_skill must be one coherent deduplicated package, targeting at most 60,000 characters while preserving reusable coverage.",
  ].join("\n")
  const request: SkillOptBridgeRequest = {
    schema: "auto-evolve/skillopt-merge-request/v1",
    skillContent: initialSkill,
    failurePatches: [],
    successPatches: sourcePackages.map((item) => ({
      reasoning: `Imported verified AEV skill ${item.id}`,
      skill_candidates: [
        {
          title: `Verified AEV skill ${item.id}`,
          change_summary: ["Imported as a complete verified source skill"],
          new_skill: item.packageText,
          support_count: 1,
          source_type: "success",
        },
      ],
    })),
    batchSize: input.config.batchSize,
    workers: input.config.workers,
    updateMode: "full_rewrite_minibatch",
    metaSkillContext: protocolInstruction,
    skillOptConfigPath: configPath,
    optimizer: {
      backend: input.config.optimizerBackend || undefined,
      model: input.config.optimizerModel || undefined,
      baseUrl: input.config.optimizerBaseUrl || undefined,
      apiKeyEnv: input.config.optimizerApiKeyEnv || undefined,
      reasoningEffort: input.config.reasoningEffort || undefined,
    },
    lengthPolicy: {
      enabled: input.config.maxSkillBytes > 0,
      maxBytes: input.config.maxSkillBytes,
      maxRepairAttempts: input.config.lengthRepairAttempts,
      unit: "utf8_bytes",
    },
    nativeTrain: input.config.pipelineMode === "native_train"
      ? {
          enabled: true,
          configPath: nativeTrainConfigPath,
          splitDir: input.config.nativeTrainSplitDir
            ? resolveConfiguredPath(projectRoot, input.config.nativeTrainSplitDir)
            : undefined,
          dataDirs: input.config.nativeTrainDataDirs.map((item) => resolveConfiguredPath(projectRoot, item)),
          outRoot: nativeTrainOutRoot,
          epochs: input.config.nativeTrainEpochs,
          batchSize: input.config.nativeTrainBatchSize,
          maxSteps: input.config.nativeTrainMaxSteps,
          evalTest: input.config.nativeTrainEvalTest,
          targetWorkers: input.config.nativeTrainTargetWorkers,
          targetBackend: input.config.targetBackend || input.config.optimizerBackend || undefined,
          targetModel: input.config.targetModel || input.config.optimizerModel || undefined,
          targetBaseUrl: input.config.targetBaseUrl || input.config.optimizerBaseUrl || undefined,
          targetApiKeyEnv: input.config.targetApiKeyEnv || input.config.optimizerApiKeyEnv || undefined,
        }
      : undefined,
  }
  const requestPath = path.join(mergerRunDir, `request-${randomUUID()}.json`)
  const resultPath = path.join(mergerRunDir, `result-${randomUUID()}.json`)
  await writeJsonFile(requestPath, request)
  const result = input.bridgeRunner
    ? await input.bridgeRunner({ request, requestPath, resultPath, runRoot: mergerRunDir })
    : await defaultBridgeRunner({
        request,
        requestPath,
        resultPath,
        runRoot: mergerRunDir,
        pythonCommand: input.config.pythonCommand,
        bridgeScript,
        projectRoot,
        timeoutMs: input.config.timeoutMs,
      })
  if (!result.passed || !result.mergedSkill?.trim()) {
    throw new Error(`SkillOpt merge did not produce a valid complete skill: ${result.error ?? "missing mergedSkill"}`)
  }
  const outputFiles = await materializeSkillPackage(result.mergedSkill, outputRoot)
  const report = {
    schema: "auto-evolve/skillopt-merge-report/v1",
    createdAt: new Date().toISOString(),
    mergePath: "merge-as-opt",
    mergedSkillDir: outputRoot,
    contributingInstances: sourcePackages.map((item) => item.id),
    outputFiles,
    inputManifestPath,
    requestPath,
    resultPath,
    reasoning: result.reasoning,
    tokenSummary: result.tokenSummary,
    pipelineMode: input.config.pipelineMode,
    warmStartSkill: result.warmStartSkill,
    nativeTrainSummary: result.nativeTrainSummary,
    nativeTrainOutRoot: result.nativeTrainOutRoot,
    nativeTrainPreflight: result.nativeTrainPreflight,
    lengthGate: result.lengthGate,
  }
  await writeJsonFile(reportPath, report)
  return {
    mergedSkillDir: outputRoot,
    contributingInstances: sourcePackages.map((item) => item.id),
    mergerRunDir,
    inputManifestPath,
    reportPath,
    tokenSummary: result.tokenSummary,
  }
}
