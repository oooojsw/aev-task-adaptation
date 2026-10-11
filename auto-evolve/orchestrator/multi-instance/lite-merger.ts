import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type { LoadedMergeAsLiteConfig } from "../schema"
import { decodeSkillPackage, encodeSkillDirectory, type SkillOptSourceSkill } from "./skillopt-merger"

export interface LiteMergeRequest {
  schema: "auto-evolve/skillopt-lite-merge-request/v1"
  sourceSkills: Array<{ id: string; packageText: string }>
  lite: {
    projectRoot: string
    runtimeRoot: string
    environment: "officeqa" | "spreadsheetbench"
    splitDir: string
    dataRoot: string
    rounds: number
    workers: number
    optimizerModel: string
    authFile: string
    providerID: string
    maxSkillBytes: number
    lengthRepairAttempts: number
    gateMetric: "hard" | "soft"
  }
  policy: {
    sourceRepresentation: "verified_aev_skill_packages"
    acceptance: "strict_validation_improvement"
    rejectAction: "rollback"
    heldoutTestDuringMerge: false
  }
}

export interface LiteMergeResult {
  schema: "auto-evolve/skillopt-lite-merge-result/v1"
  passed: boolean
  mergedSkill?: string
  bestRound?: number
  bestScore?: number
  baselineScore?: number
  gateLedger?: unknown[]
  tokenSummary?: unknown
  error?: string
}

export type LiteBridgeRunner = (input: {
  request: LiteMergeRequest
  requestPath: string
  resultPath: string
  runRoot: string
}) => Promise<LiteMergeResult>

export interface RunLiteMergerInput {
  cwd: string
  runRoot: string
  config: LoadedMergeAsLiteConfig
  sourceSkills: SkillOptSourceSkill[]
  bridgeRunner?: LiteBridgeRunner
}

export interface LiteMergerOutcome {
  mergedSkillDir: string
  contributingInstances: string[]
  mergerRunDir: string
  inputManifestPath: string
  reportPath: string
  tokenSummary?: unknown
}

function resolveConfiguredPath(base: string, value: string) {
  if (!value.trim()) return ""
  return path.resolve(path.isAbsolute(value) ? value : path.join(base, value))
}

function assertInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return
  throw new Error(`Refusing to write a Lite merge artifact outside its output root: ${target}`)
}

async function sha256File(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex")
}

async function materializePackage(packageText: string, outputRoot: string) {
  const files = decodeSkillPackage(packageText)
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
  requestPath: string
  resultPath: string
  runRoot: string
  pythonCommand: string
  bridgeScript: string
  timeoutMs: number
}) {
  const child = Bun.spawn(
    [input.pythonCommand, input.bridgeScript, "--request", input.requestPath, "--result", input.resultPath],
    {
      cwd: input.runRoot,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, input.timeoutMs)
  const exitCode = await child.exited.finally(() => clearTimeout(timer))
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  await writeTextFile(path.join(input.runRoot, "stdout.log"), stdout)
  await writeTextFile(path.join(input.runRoot, "stderr.log"), stderr)
  if (timedOut) throw new Error(`merge-as-lite timed out after ${input.timeoutMs}ms`)
  if (exitCode !== 0) throw new Error(`merge-as-lite bridge exited with code ${exitCode}: ${stderr.slice(-2000)}`)
  if (!(await pathExists(input.resultPath))) throw new Error("merge-as-lite bridge did not write its result JSON")
  return await readJsonFile<LiteMergeResult>(input.resultPath, { validatePaths: false })
}

export async function runLiteMerger(input: RunLiteMergerInput): Promise<LiteMergerOutcome> {
  if (!input.sourceSkills.length) throw new Error("merge-as-lite requires at least one verified source skill")
  if (input.config.rounds < 1 || input.config.workers < 1) {
    throw new Error("merge-as-lite requires rounds >= 1 and workers >= 1")
  }

  const sourceIDs = new Set<string>()
  for (const source of input.sourceSkills) {
    const key = source.id.trim().toLowerCase()
    if (!key || sourceIDs.has(key)) throw new Error(`merge-as-lite source ID is empty or duplicated: ${source.id}`)
    sourceIDs.add(key)
  }

  const projectRoot = resolveConfiguredPath(input.cwd, input.config.projectRoot)
  const runtimeRoot = resolveConfiguredPath(input.cwd, input.config.runtimeRoot)
  const splitDir = resolveConfiguredPath(runtimeRoot || input.cwd, input.config.splitDir)
  const dataRoot = resolveConfiguredPath(runtimeRoot || input.cwd, input.config.dataRoot)
  const authFile = resolveConfiguredPath(input.cwd, input.config.authFile)
  const promptPath = path.join(
    projectRoot,
    "copilot_example",
    input.config.environment,
    ".github",
    "prompts",
    "skillopt-loop.prompt.md",
  )
  const runtimeRunner = path.join(runtimeRoot, "tools", "lite_minimax_runner.py")
  for (const [label, target] of [
    ["official SkillOpt-Lite root", projectRoot],
    ["SkillOpt-Lite loop prompt", promptPath],
    ["Lite runtime root", runtimeRoot],
    ["Lite runtime evaluator", runtimeRunner],
    ["split directory", splitDir],
    ["data root", dataRoot],
    ["auth file", authFile],
  ] as const) {
    if (!target || !(await pathExists(target))) throw new Error(`merge-as-lite requires an existing ${label}: ${target}`)
  }

  const logicalRunDir = path.resolve(input.runRoot)
  const externalOutputRoot = input.config.outputRoot.trim()
    ? resolveConfiguredPath(input.cwd, input.config.outputRoot)
    : ""
  const runFingerprint = createHash("sha256").update(logicalRunDir.replace(/\\/g, "/")).digest("hex").slice(0, 12)
  // 大产物可外置到 E 盘，但逻辑 Run 指纹保持稳定可追溯。
  const mergerRunDir = externalOutputRoot
    ? path.join(externalOutputRoot, `${path.basename(logicalRunDir)}-${runFingerprint}`)
    : logicalRunDir
  await ensureDirectory(mergerRunDir)
  const outputRoot = path.join(mergerRunDir, `output-${randomUUID()}`)
  const inputManifestPath = path.join(mergerRunDir, "input-manifest.json")
  const reportPath = path.join(mergerRunDir, "report.json")
  const requestPath = path.join(mergerRunDir, `request-${randomUUID()}.json`)
  const resultPath = path.join(mergerRunDir, `result-${randomUUID()}.json`)
  const bridgeScript = resolveConfiguredPath(path.join(input.cwd, "auto-evolve"), input.config.bridgeScript)
  if (!input.bridgeRunner && (!(await pathExists(bridgeScript)) || !input.config.pythonCommand.trim())) {
    throw new Error(`merge-as-lite bridge preflight failed: ${bridgeScript}`)
  }

  const promptHashBefore = await sha256File(promptPath)
  const sourcePackages = [] as Array<{ id: string; skillRoot: string; packageText: string }>
  for (const source of input.sourceSkills) {
    sourcePackages.push({
      id: source.id,
      skillRoot: path.resolve(source.skillRoot),
      packageText: await encodeSkillDirectory(source.skillRoot),
    })
  }

  // 只读引用 Lite 源码，所有候选与评测产物留在独立 Run。
  const request: LiteMergeRequest = {
    schema: "auto-evolve/skillopt-lite-merge-request/v1",
    sourceSkills: sourcePackages.map(({ id, packageText }) => ({ id, packageText })),
    lite: {
      projectRoot,
      runtimeRoot,
      environment: input.config.environment,
      splitDir,
      dataRoot,
      rounds: input.config.rounds,
      workers: input.config.workers,
      optimizerModel: input.config.optimizerModel,
      authFile,
      providerID: input.config.providerID,
      maxSkillBytes: input.config.maxSkillBytes,
      lengthRepairAttempts: input.config.lengthRepairAttempts,
      gateMetric: input.config.gateMetric,
    },
    policy: {
      sourceRepresentation: "verified_aev_skill_packages",
      acceptance: "strict_validation_improvement",
      rejectAction: "rollback",
      heldoutTestDuringMerge: false,
    },
  }
  await writeJsonFile(requestPath, request)
  await writeJsonFile(inputManifestPath, {
    schema: "auto-evolve/skillopt-lite-merge-input-manifest/v1",
    createdAt: new Date().toISOString(),
    mergePath: "merge-as-lite",
    sourceSkills: sourcePackages.map(({ id, skillRoot }) => ({ id, skillRoot })),
    officialLite: { projectRoot, promptPath, promptSha256: promptHashBefore },
    adapterRuntime: { runtimeRoot, runtimeRunner },
    policy: request.policy,
  })

  const result = input.bridgeRunner
    ? await input.bridgeRunner({ request, requestPath, resultPath, runRoot: mergerRunDir })
    : await defaultBridgeRunner({
        requestPath,
        resultPath,
        runRoot: mergerRunDir,
        pythonCommand: input.config.pythonCommand,
        bridgeScript,
        timeoutMs: input.config.timeoutMs,
      })
  if (!result.passed || !result.mergedSkill?.trim()) {
    throw new Error(`merge-as-lite did not produce a valid best skill: ${result.error ?? "missing mergedSkill"}`)
  }
  if ((await sha256File(promptPath)) !== promptHashBefore) {
    throw new Error("merge-as-lite detected a modification to the official SkillOpt-Lite prompt and refused the result")
  }
  const decodedOutput = decodeSkillPackage(result.mergedSkill)
  if (decodedOutput.length !== 1 || decodedOutput[0]?.path !== "CORE.md") {
    throw new Error("merge-as-lite requires exactly one deployable CORE.md file")
  }
  const deployedBytes = Buffer.byteLength(`${decodedOutput[0].content}\n`, "utf8")
  if (input.config.maxSkillBytes > 0 && deployedBytes > input.config.maxSkillBytes) {
    throw new Error(`merge-as-lite result exceeds the ${input.config.maxSkillBytes}-byte hard limit`)
  }

  const outputFiles = await materializePackage(result.mergedSkill, outputRoot)
  await writeJsonFile(reportPath, {
    schema: "auto-evolve/skillopt-lite-merge-report/v1",
    createdAt: new Date().toISOString(),
    mergePath: "merge-as-lite",
    implementation: "aev_adapter_over_readonly_skillopt_lite",
    mergedSkillDir: outputRoot,
    contributingInstances: sourcePackages.map((item) => item.id),
    outputFiles,
    deployedBytes,
    inputManifestPath,
    requestPath,
    resultPath,
    baselineScore: result.baselineScore,
    bestScore: result.bestScore,
    bestRound: result.bestRound,
    gateLedger: result.gateLedger,
    tokenSummary: result.tokenSummary,
    heldoutTestDuringMerge: false,
  })
  return {
    mergedSkillDir: outputRoot,
    contributingInstances: sourcePackages.map((item) => item.id),
    mergerRunDir,
    inputManifestPath,
    reportPath,
    tokenSummary: result.tokenSummary,
  }
}
