import path from "node:path"
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { loadConfig } from "../orchestrator/schema"
import { runOpencodeTask } from "../orchestrator/opencode"
import { autoEvolvePath, pathExists } from "../orchestrator/fs"

type Snapshot = Record<string, { size: number; sha256: string }>

function nowStamp() {
  const now = new Date()
  const p = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${randomUUID().slice(0, 8)}`
}

async function readJsonSafe(file: string) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
  } catch {
    return undefined
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFiles(root, full)))
      continue
    }
    if (entry.isFile()) out.push(path.relative(root, full).replace(/\\/g, "/"))
  }
  return out.sort()
}

async function snapshot(root: string): Promise<Snapshot> {
  const files = await listFiles(root)
  const out: Snapshot = {}
  for (const rel of files) {
    const full = path.join(root, rel)
    const bytes = await readFile(full)
    out[rel] = {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  }
  return out
}

function diffSnapshot(before: Snapshot, after: Snapshot) {
  const added = Object.keys(after).filter((key) => !before[key]).sort()
  const removed = Object.keys(before).filter((key) => !after[key]).sort()
  const changed = Object.keys(after)
    .filter((key) => before[key] && before[key].sha256 !== after[key].sha256)
    .sort()
  return { added, removed, changed }
}

async function copyIfExists(source: string, target: string) {
  if (!(await pathExists(source))) return false
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, force: true })
  return true
}

function summarizeTrainState(state: any) {
  const rows = Array.isArray(state?.trainResults) ? state.trainResults : []
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.status ?? "unknown"] = (counts[row.status ?? "unknown"] ?? 0) + 1
  return {
    updatedAt: state?.updatedAt,
    phase: state?.phase,
    counts,
    active: rows
      .filter((row: any) => ["running", "bootstrapping", "recovery_pending", "queued"].includes(row.status))
      .map((row: any) => ({
        id: row.id,
        status: row.status,
        campaign: typeof row.campaignDir === "string" ? path.basename(row.campaignDir) : undefined,
      })),
  }
}

async function main() {
  const cwd = process.cwd()
  const config = await loadConfig(cwd)
  const runID = process.argv.includes("--run-id")
    ? process.argv[process.argv.indexOf("--run-id") + 1]
    : "20260622-171219-spreadsheetbench-official80-minimax27-hier5"
  const liveRead = process.argv.includes("--live-read")
  if (!runID) throw new Error("Missing --run-id value.")

  const benchmarkRoot = autoEvolvePath(cwd, "runtime-state", "benchmark-runs", runID)
  if (!(await pathExists(benchmarkRoot))) throw new Error(`Benchmark run not found: ${benchmarkRoot}`)
  const taskPackRoot = autoEvolvePath(cwd, "task-packs", "real-long-tasks", "spreadsheetbench-learnbench")
  const campaignRoot = autoEvolvePath(cwd, "runtime-state", "long-task-campaigns")

  const smokeRoot = autoEvolvePath(cwd, "runtime-state", "third-party-audit-smokes", nowStamp())
  const sandboxRoot = path.join(smokeRoot, "sandbox")
  const inputRoot = path.join(sandboxRoot, "readonly-input")
  const outputRoot = path.join(smokeRoot, "outputs")
  await rm(smokeRoot, { recursive: true, force: true })
  await mkdir(inputRoot, { recursive: true })
  await mkdir(outputRoot, { recursive: true })

  const state = await readJsonSafe(path.join(benchmarkRoot, "orchestrator-state.json"))
  const trainSummary = summarizeTrainState(state)
  await writeFile(
    path.join(inputRoot, "audit-input.json"),
    `${JSON.stringify({ runID, benchmarkRoot, taskPackRoot, campaignRoot, liveRead, trainSummary }, null, 2)}\n`,
    "utf8",
  )
  if (!liveRead) {
    await copyIfExists(path.join(benchmarkRoot, "orchestrator-state.json"), path.join(inputRoot, "benchmark", "orchestrator-state.json"))
    await copyIfExists(path.join(benchmarkRoot, "train-queue-results.json"), path.join(inputRoot, "benchmark", "train-queue-results.json"))
    await copyIfExists(path.join(benchmarkRoot, "train-plan.json"), path.join(inputRoot, "benchmark", "train-plan.json"))
    await copyIfExists(path.join(benchmarkRoot, "scorecard.md"), path.join(inputRoot, "benchmark", "scorecard.md"))
    await copyIfExists(autoEvolvePath(cwd, "README.md"), path.join(inputRoot, "project", "README.md"))
    await copyIfExists(autoEvolvePath(cwd, "AGENTS.md"), path.join(inputRoot, "project", "AGENTS.md"))

    for (const item of trainSummary.active.slice(0, 8)) {
      if (!item.campaign) continue
      const source = path.join(campaignRoot, item.campaign, "campaign.json")
      await copyIfExists(source, path.join(inputRoot, "campaigns", item.id, "campaign.json"))
    }
  }

  const promptPath = path.join(inputRoot, "audit-prompt.md")
  const prompt = [
    "# Third-party readonly audit smoke",
    "",
    "你是一个完全独立的第三方审查 agent。你不是训练 worker，不负责修改 skill，不负责继续任务。",
    "",
    "你的目标是验证这条链路是否可行：",
    liveRead
      ? "- readonly-input/audit-input.json 里列出了真实 benchmarkRoot / campaignRoot / taskPackRoot。你可以直接读取这些真实路径。"
      : "- 所有审查材料都在 readonly-input 目录。",
    "- 你可以读取这些材料。",
    "- 你不能写入、修改、删除任何文件。",
    "- 你不能调用 shell。",
    "- 你只能在最终回复中输出 JSON。",
    "",
    "请读取：",
    "- readonly-input/audit-input.json",
    liveRead
      ? "- audit-input.json 里的 benchmarkRoot/orchestrator-state.json、train-queue-results.json、train-plan.json、scorecard.md"
      : "- readonly-input/benchmark/orchestrator-state.json",
    liveRead ? "- audit-input.json 里的 campaignRoot/<active campaign>/campaign.json" : "- readonly-input/benchmark/train-queue-results.json（如果存在）",
    liveRead ? "- 必要时读取真实 blank-eval-runs 或 campaign rounds 里的结果文件，但不要写文件" : "- readonly-input/campaigns/*/campaign.json（如果存在）",
    "",
    "最终只输出 JSON：",
    "{",
    '  "readonly_audit_possible": true,',
    '  "saw_run_id": "...",',
    '  "observed_counts": {"verified_success": 0},',
    '  "high_risk_items": [{"id":"...","reason":"..."}],',
    '  "would_recommend": "continue | pause_for_platform_fix | deep_inspect",',
    '  "notes": "short Chinese summary"',
    "}",
    "",
    "不要写文件。不要要求权限。不要编造未读取到的路径。",
  ].join("\n")
  await writeFile(promptPath, prompt, "utf8")

  const before = await snapshot(sandboxRoot)
  const task = await runOpencodeTask({
    cwd,
    workDir: sandboxRoot,
    config,
    title: "Third Party Readonly Audit Smoke",
    prompt,
    referencePaths: liveRead ? [promptPath, inputRoot, benchmarkRoot, campaignRoot, taskPackRoot] : [promptPath, inputRoot],
    permissionReadPaths: liveRead ? [cwd, inputRoot, promptPath, benchmarkRoot, campaignRoot, taskPackRoot] : [inputRoot, promptPath],
    permissionEditPaths: [],
    allowShell: false,
    runtimeScope: "third-party-readonly-audit-smoke",
    recordAdaptiveConcurrency: false,
    runtimeBudget: {
      profile: "short",
      hardTimeoutMs: 10 * 60 * 1000,
      silentTimeoutMs: 4 * 60 * 1000,
      silentTimeoutAfterActivityMs: 6 * 60 * 1000,
    },
  })
  const after = await snapshot(sandboxRoot)
  const diff = diffSnapshot(before, after)
  const report = {
    ok: task.result.exitCode === 0 && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0,
    exitCode: task.result.exitCode,
    mode: liveRead ? "live-read" : "copied-input",
    sandboxRoot,
    outputRoot,
    liveReadRoots: liveRead ? { cwd, benchmarkRoot, campaignRoot, taskPackRoot } : undefined,
    model: task.selectedModelResolution,
    diff,
    responseText: task.result.responseText.slice(0, 4000),
    stderrTail: task.result.stderr.slice(-2000),
  }
  await writeFile(path.join(outputRoot, "readonly-audit-smoke-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

await main()
