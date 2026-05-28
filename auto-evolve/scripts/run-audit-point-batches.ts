import path from "node:path"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { pathExists } from "../orchestrator/fs"
import { createCoordinatorRun } from "../orchestrator/multi-instance/coordinator"
import { runCoordinatorPhase2Merge } from "../orchestrator/multi-instance/merger"
import { runCoordinatorPhase3Validate } from "../orchestrator/multi-instance/validator"
import { saveCoordinatorState } from "../orchestrator/multi-instance/repository"

type Row = {
  id: string
  status: string
  cdir: string
  pending: string
  updated: string
  code?: number
}

type Pick = {
  id: string
  spec: string
  campaign?: string
}

const cwd = path.resolve(import.meta.dir, "..", "..")
const auto = path.join(cwd, "auto-evolve")
const root = path.join(auto, "task-packs", "real-long-tasks", "audit-point-learnbench")
const out = path.join(auto, "runtime-state", "audit-point-batches", stamp())
const max = Number.parseInt(process.env.AUDIT_POINT_QUEUE_CONCURRENCY ?? "5", 10)
const dry = process.env.AUDIT_POINT_QUEUE_DRY_RUN === "1"
const backtestRounds = Number.parseInt(process.env.AUDIT_POINT_TRAIN_BACKTEST_ROUNDS ?? "1", 10)
const repairAttempts = Number.parseInt(process.env.AUDIT_POINT_REPAIR_ATTEMPTS ?? "1", 10)
const skipFinalSanity = process.env.AUDIT_POINT_SKIP_FINAL_SANITY !== "0"
const runTests = process.env.AUDIT_POINT_RUN_TESTSETS_AFTER_BACKTEST !== "0"
const list = Array.from({ length: 20 }, (_, i) => `audit-point-${String(i + 1).padStart(3, "0")}`)

function stamp() {
  const d = new Date()
  const p = (v: number, w = 2) => String(v).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

function spec(id: string) {
  return path.join(root, "tasks", id, "campaign.json")
}

function base(id: string) {
  return path.join(root, "tasks", id, "spec.json")
}

function score(row: Row) {
  return Date.parse(row.updated || "") || 0
}

async function campaigns() {
  const dir = path.join(auto, "runtime-state", "long-task-campaigns")
  const got = new Map<string, Row[]>()
  const ls = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const it of ls) {
    if (!it.isDirectory()) continue
    const file = path.join(dir, it.name, "campaign.json")
    if (!(await pathExists(file))) continue
    const raw = await readFile(file, "utf8").catch(() => "")
    if (!raw.trim()) continue
    const row = JSON.parse(raw) as Record<string, unknown>
    const hit = list.find((id) => path.resolve(String(row.baseSpecPath ?? "")) === path.resolve(base(id)))
    if (!hit) continue
    const cdir = path.join(dir, it.name)
    const pending = path.join(cdir, "pending-expert-package", "current")
    const rec: Row = {
      id: hit,
      status: String(row.status ?? ""),
      cdir,
      pending,
      updated: String(row.updatedAt ?? row.createdAt ?? ""),
    }
    got.set(hit, [...(got.get(hit) ?? []), rec])
  }
  for (const [id, rows] of got) got.set(id, rows.sort((a, b) => score(b) - score(a)))
  return got
}

async function done(map?: Map<string, Row[]>) {
  const src = map ?? (await campaigns())
  const got = new Map<string, Row>()
  for (const id of list) {
    for (const row of src.get(id) ?? []) {
      if (row.status !== "verified_success") continue
      if (!(await pathExists(row.pending))) continue
      got.set(id, row)
      break
    }
  }
  return got
}

async function plan() {
  const map = await campaigns()
  const ok = await done(map)
  const todo: Pick[] = []
  for (const id of list) {
    if (ok.has(id)) continue
    const latest = map.get(id)?.[0]
    const live = latest && ["running", "bootstrapping", "recovery_pending"].includes(latest.status)
    todo.push({
      id,
      spec: spec(id),
      campaign: live ? path.basename(latest.cdir) : undefined,
    })
  }
  return { ok, todo }
}

async function runOne(pick: Pick) {
  const dir = path.join(out, "queue")
  await mkdir(dir, { recursive: true })
  const args = pick.campaign
    ? ["run", "cli.ts", "resume-long-task-campaign", "--campaign", pick.campaign, "--spec", pick.spec]
    : ["run", "cli.ts", "run-long-task-campaign", "--spec", pick.spec]
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: auto,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  await writeFile(path.join(dir, `${pick.id}.stdout.log`), stdout, "utf8")
  await writeFile(path.join(dir, `${pick.id}.stderr.log`), stderr, "utf8")
  const map = await campaigns()
  const ok = await done(map)
  const hit = ok.get(pick.id) ?? map.get(pick.id)?.[0]
  return {
    id: pick.id,
    code,
    status: hit?.status ?? "unknown",
    cdir: hit?.cdir ?? "",
    pending: hit?.pending ?? "",
    has: hit ? hit.status === "verified_success" && (await pathExists(hit.pending)) : false,
  }
}

async function queue(todo: Pick[]) {
  const rows: Awaited<ReturnType<typeof runOne>>[] = []
  let next = 0
  const active = new Set<Promise<void>>()
  async function start(pick: Pick) {
    const task = runOne(pick)
      .then((row) => {
        rows.push(row)
      })
      .finally(() => active.delete(task))
    active.add(task)
  }
  while (next < todo.length || active.size > 0) {
    while (next < todo.length && active.size < Math.max(1, max)) {
      await start(todo[next++]!)
    }
    if (active.size > 0) await Promise.race(active)
    await writeFile(path.join(out, "queue-results.json"), JSON.stringify(rows, null, 2), "utf8")
  }
  return rows
}

async function merge(ok: Map<string, Row>) {
  if (ok.size !== list.length) {
    await writeFile(
      path.join(out, "merge-skipped.json"),
      JSON.stringify(
        {
          reason: "not_all_training_instances_verified",
          required: list.length,
          verified: ok.size,
          missing: list.filter((id) => !ok.has(id)),
        },
        null,
        2,
      ),
      "utf8",
    )
    return
  }

  const state = await createCoordinatorRun({
    cwd,
    runRoot: path.join(out, "merge-run"),
    label: "audit-point-learnbench-merge",
    rounds: 1,
    instances: list.map((id) => ({
      id,
      sourceTaskRoot: path.join(root, "tasks", id),
      engine: "skillsbench" as const,
      skillsbenchRoot: root,
      taskID: id,
      role: "train" as const,
    })),
    fanoutLimit: 1,
  })
  for (const inst of state.instances) {
    const hit = ok.get(inst.id)
    inst.status = hit ? "passed" : "failed"
    inst.finishedAt = new Date().toISOString()
    inst.campaignDir = hit?.cdir
    inst.harvestedSkillPath = hit?.pending
    inst.errorMessage = hit ? undefined : "missing verified campaign"
  }
  await saveCoordinatorState(state)
  const res = await runCoordinatorPhase2Merge({ cwd, state })
  await writeFile(path.join(out, "merge-output.json"), JSON.stringify(res, null, 2), "utf8")
  if (res.contributingInstances.length === 0) return

  state.mergedSkillDir = res.mergedSkillDir
  await saveCoordinatorState(state)
  const backtest = await runCoordinatorPhase3Validate({
    cwd,
    state,
    rounds: Math.max(1, backtestRounds),
    validateLimit: Math.max(1, max),
    filter: (instance) => instance.role === "train" && instance.status === "passed",
    repair: {
      enabled: true,
      mode: "append_only",
      maxAttemptsPerCase: Math.max(1, repairAttempts),
    },
  })
  const final =
    !skipFinalSanity && (backtest.repairFixed ?? 0) > 0
      ? await runCoordinatorPhase3Validate({
          cwd,
          state,
          rounds: Math.max(1, backtestRounds),
          validateLimit: Math.max(1, max),
          filter: (instance) => instance.role === "train" && instance.status === "passed",
        })
      : backtest
  await writeFile(
    path.join(out, "train-backtest-output.json"),
    JSON.stringify(
      {
        ...final,
        repairBacktest: backtest,
        finalSanity: skipFinalSanity ? undefined : final,
        skippedFinalSanity: skipFinalSanity,
        mergedSkillDir: state.mergedSkillDir,
      },
      null,
      2,
    ),
    "utf8",
  )
  if (runTests) {
    const test = Bun.spawn(["bun", "run", "scripts/run-audit-point-testsets.ts"], {
      cwd: auto,
      env: {
        ...process.env,
        AUDIT_POINT_TEST_CONCURRENCY: process.env.AUDIT_POINT_TEST_CONCURRENCY ?? String(Math.max(1, max)),
        AUDIT_POINT_TEST_GROUPS: process.env.AUDIT_POINT_TEST_GROUPS ?? "all",
        AUDIT_POINT_TEST_ROUNDS: process.env.AUDIT_POINT_TEST_ROUNDS ?? "1",
      },
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await test.exited
    if (code !== 0) throw new Error(`audit-point testsets failed with exit code ${code}`)
  }
}

async function main() {
  await mkdir(out, { recursive: true })
  const before = await plan()
  await writeFile(
    path.join(out, "queue-plan.json"),
    JSON.stringify(
      {
        concurrency: Math.max(1, max),
        dryRun: dry,
        alreadyVerified: Array.from(before.ok.keys()),
        todo: before.todo,
      },
      null,
      2,
    ),
    "utf8",
  )
  if (dry) {
    console.log(`RUN_ROOT=${out}`)
    console.log(`DRY_RUN=1`)
    console.log(`VERIFIED=${before.ok.size}/${list.length}`)
    console.log(`TODO=${before.todo.length}`)
    return
  }
  const rows = await queue(before.todo)
  await writeFile(path.join(out, "queue-results.json"), JSON.stringify(rows, null, 2), "utf8")
  const ok = await done()
  await writeFile(path.join(out, "verified-results.json"), JSON.stringify(Array.from(ok.values()), null, 2), "utf8")
  await merge(ok)
  console.log(`RUN_ROOT=${out}`)
  console.log(`VERIFIED=${ok.size}/${list.length}`)
}

await main()
