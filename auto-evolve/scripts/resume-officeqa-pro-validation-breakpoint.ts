import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resumeLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

const cwd = path.resolve(import.meta.dir, "..", "..")
const taskPackRoot = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const campaignRoot = path.join(cwd, "auto-evolve", "runtime-state", "long-task-campaigns")
const batchResultRoot = path.join(cwd, "runtime-state", "officeqa-pro-runs")
const splitFile = path.join(taskPackRoot, "splits", "first-five.json")
const continueToRounds = Number.parseInt(process.env.OFFICEQA_PRO_CONTINUE_TO_ROUNDS ?? "5", 10)
const limit = Number.parseInt(process.env.OFFICEQA_PRO_RUN_LIMIT ?? "5", 10)
const continueFailed = process.env.OFFICEQA_PRO_CONTINUE_FAILED !== "0"

type Json = Record<string, any>

type BatchEntry = {
  id: string
  status: string
  roundsCompleted: number
  campaignDir: string
  finalSummary?: string
}

async function readJson<T = Json>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function latestBatchResultFile() {
  if (!existsSync(batchResultRoot)) return undefined
  const files = (await readdir(batchResultRoot, { withFileTypes: true }))
    .filter((item) => item.isFile() && item.name.endsWith("-result.json"))
    .map((item) => path.join(batchResultRoot, item.name))
  if (files.length === 0) return undefined
  files.sort()
  return files.at(-1)
}

async function findCampaignDir(id: string, batchEntries: BatchEntry[]) {
  const fromBatch = batchEntries.find((item) => item.id.toLowerCase() === id.toLowerCase())?.campaignDir
  if (fromBatch && existsSync(fromBatch)) return fromBatch
  const needle = `officeqa-pro-campaign-${id.toLowerCase()}`
  const dirs = (await readdir(campaignRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && item.name.toLowerCase().includes(needle))
    .map((item) => path.join(campaignRoot, item.name))
  dirs.sort()
  return dirs.at(-1)
}

async function runValidator(input: {
  id: string
  taskDir: string
  passRoot: string
  spec: Json
}) {
  const validator = input.spec.validators.find((item: Json) => item.id === "officeqa-answer-validate")
  if (!validator) throw new Error(`${input.id}: missing officeqa-answer-validate`)
  const validatorRoot = path.join(input.passRoot, validator.id)
  await mkdir(validatorRoot, { recursive: true })

  const validatorPath = path.resolve(input.taskDir, validator.path)
  const normalizedArgs = validator.args.map((arg: string, index: number) => {
    const prev = validator.args[index - 1]
    if (prev === "--candidate" && arg.startsWith(".")) return path.resolve(input.taskDir, arg)
    if (prev === "--reward" && arg.startsWith(".")) return path.resolve(input.taskDir, arg)
    return arg
  })
  const validatorInputPath = path.join(validatorRoot, "validator_input.json")
  const stdoutPath = path.join(validatorRoot, "stdout.log")
  const stderrPath = path.join(validatorRoot, "stderr.log")
  await writeJson(validatorInputPath, {
    id: input.id,
    reason: "validation-breakpoint-resume",
    note: "This intentionally appends validator_input.json to mirror the real platform validator invocation.",
  })

  const proc = Bun.spawnSync({
    cmd: [validator.runner ?? "python", validatorPath, ...normalizedArgs, validatorInputPath],
    cwd: input.taskDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array())
  const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array())
  await writeFile(stdoutPath, stdout, "utf8")
  await writeFile(stderrPath, stderr, "utf8")

  const passed = proc.exitCode === 0
  const summary = passed
    ? "OfficeQA answer validation passed after breakpoint resume."
    : `OfficeQA answer validation failed after breakpoint resume with exit code ${proc.exitCode}.`
  return {
    id: `validator-resume-${randomUUID()}`,
    runID: `validation-breakpoint-${input.id}`,
    unitID: "campaign-final-acceptance",
    attempt: 1,
    validatorID: validator.id,
    validatorType: validator.type,
    createdAt: new Date().toISOString(),
    passed,
    blocking: validator.blocking !== false,
    summary,
    details: [stdout, stderr].filter((text) => text.trim().length > 0),
    evidenceRefs: [validatorInputPath, stdoutPath, stderrPath],
    rawOutputPath: stdoutPath,
  }
}

async function replayFinalAcceptance(input: {
  id: string
  campaignDir: string
}) {
  const statePath = path.join(input.campaignDir, "campaign.json")
  const state = await readJson<Json>(statePath)
  const taskDir = path.join(taskPackRoot, "tasks", input.id)
  const specPath = path.join(taskDir, "spec.json")
  const spec = await readJson<Json>(specPath)
  const roundNumber = Number(state.currentRound ?? state.maxRounds ?? 3)
  const roundDir = path.join(input.campaignDir, "rounds", `round-${String(roundNumber).padStart(3, "0")}`)
  const passID = `pass-resume-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const passRoot = path.join(roundDir, "final-acceptance", passID)
  const passResultPath = path.join(passRoot, "result.json")
  const roundResultPath = path.join(roundDir, "final-acceptance", "result.json")
  const bundlePath = path.join(passRoot, "final-acceptance-bundle.json")
  await mkdir(passRoot, { recursive: true })
  await writeJson(bundlePath, {
    id: input.id,
    campaignID: state.id,
    reason: "validation-breakpoint-resume",
    sourceRound: roundNumber,
  })

  const validatorResult = await runValidator({ id: input.id, taskDir, passRoot, spec })
  const finalAcceptance = {
    campaignID: state.id,
    roundNumber,
    runID: state.lastRunID ?? `validation-breakpoint-${input.id}`,
    passed: validatorResult.passed,
    summary: validatorResult.summary,
    validatorResults: [validatorResult],
    bundlePath,
    validationPackageRoot: path.join(passRoot, "validation-expert-workspace"),
    createdAt: new Date().toISOString(),
  }
  await writeJson(passResultPath, finalAcceptance)
  await writeJson(roundResultPath, finalAcceptance)

  const now = new Date().toISOString()
  if (validatorResult.passed) {
    await writeJson(statePath, {
      ...state,
      status: "verified_success",
      updatedAt: now,
      heartbeatAt: now,
      lastSummary: validatorResult.summary,
      lastFinalAcceptancePassed: true,
      lastFinalAcceptanceResultPath: passResultPath,
    })
  } else {
    const campaignSpecPath = path.join(taskDir, "campaign.json")
    const campaignSpec = await readJson<Json>(campaignSpecPath)
    await writeJson(campaignSpecPath, {
      ...campaignSpec,
      maxRounds: Math.max(Number(campaignSpec.maxRounds ?? 3), continueToRounds),
    })
    await writeJson(statePath, {
      ...state,
      status: "recovery_pending",
      maxRounds: Math.max(Number(state.maxRounds ?? 3), continueToRounds),
      updatedAt: now,
      heartbeatAt: undefined,
      ownerPID: undefined,
      ownerCommandHint: undefined,
      lastSummary: validatorResult.summary,
      lastFinalAcceptancePassed: false,
      lastFinalAcceptanceResultPath: passResultPath,
    })
  }

  return {
    id: input.id,
    campaignID: state.id as string,
    campaignDir: input.campaignDir,
    passed: validatorResult.passed,
    summary: validatorResult.summary,
    passResultPath,
  }
}

async function main() {
  const ids = ((await readJson<string[]>(splitFile)) as string[]).slice(0, Math.max(1, limit))
  const batchFile = await latestBatchResultFile()
  const batchEntries = batchFile ? await readJson<BatchEntry[]>(batchFile) : []
  const replayResults = []
  const toContinue = []

  for (const id of ids) {
    const campaignDir = await findCampaignDir(id, batchEntries)
    if (!campaignDir) throw new Error(`${id}: campaign dir not found`)
    const replay = await replayFinalAcceptance({ id, campaignDir })
    replayResults.push(replay)
    if (!replay.passed) toContinue.push(replay)
    console.log(`[validation-breakpoint] ${id} ${replay.passed ? "PASS" : "FAIL"} ${replay.summary}`)
  }

  if (batchFile) {
    const updated = batchEntries.map((entry) => {
      const replay = replayResults.find((item) => item.id === entry.id)
      if (!replay) return entry
      return {
        ...entry,
        status: replay.passed ? "verified_success" : "validation_failed_resuming",
        finalSummary: replay.summary,
      }
    })
    await writeJson(batchFile, updated)
  }

  const resumed = []
  if (continueFailed) {
    for (const item of toContinue) {
      const specPath = path.join(taskPackRoot, "tasks", item.id, "campaign.json")
      console.log(`[continue] ${item.id} campaign=${item.campaignID} maxRounds=${continueToRounds}`)
      const result = await resumeLongTaskCampaign({ cwd, campaignID: item.campaignID, specPath })
      resumed.push({
        id: item.id,
        status: result.status,
        roundsCompleted: result.roundsCompleted,
        campaignDir: result.campaignDir,
        finalSummary: result.finalSummary,
      })
      console.log(`[continue-done] ${item.id} ${result.status} rounds=${result.roundsCompleted}`)
    }
  }

  const outFile = path.join(
    batchResultRoot,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-validation-breakpoint-resume.json`,
  )
  await writeJson(outFile, {
    replayResults,
    continued: resumed,
    batchFile,
    continueFailed,
    continueToRounds,
  })
  console.log(JSON.stringify({ outFile, replayResults, continued: resumed }, null, 2))
}

await main()
