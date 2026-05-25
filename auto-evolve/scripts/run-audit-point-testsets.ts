import path from "node:path"
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { createCoordinatorRun } from "../orchestrator/multi-instance/coordinator"
import { runCoordinatorPhase3Validate } from "../orchestrator/multi-instance/validator"
import { pathExists } from "../orchestrator/fs"
import { appendCoordinatorLog, saveCoordinatorState } from "../orchestrator/multi-instance/repository"

type Item = {
  id: string
  mode: "reproduce" | "discovery"
  specPath: string
}

type Group = {
  name: "reproduce" | "discovery"
  description: string
  instanceIDs: string[]
}

type Spec = {
  instances: Item[]
  groups: Group[]
}

const materialFixes = new Map<string, string>([
  ["../../../audit-report-pilot/materials/瀹氱", "../../../audit-report-pilot/materials/定稿"],
  ["../../../audit-report-pilot/materials/鐢靛瓙搴曠", "../../../audit-report-pilot/materials/电子底稿"],
])

const cwd = path.resolve(import.meta.dir, "..", "..")
const auto = path.join(cwd, "auto-evolve")
const mats = path.join(auto, "task-packs", "real-long-tasks", "audit-report-pilot", "materials")
const final = path.join(mats, "\u5b9a\u7a3f")
const papers = path.join(mats, "\u7535\u5b50\u5e95\u7a3f")
const rawFixes = new Map<string, string>([
  ["../../../audit-report-pilot/materials/瀹氱", "../../../audit-report-pilot/materials/定稿"],
  ["../../../audit-report-pilot/materials/鐢靛瓙搴曠", "../../../audit-report-pilot/materials/电子底稿"],
])
const pathFixes = new Map<string, string>([
  ["../../../audit-report-pilot/materials/定稿", final],
  ["../../../audit-report-pilot/materials/电子底稿", papers],
  ["../../../audit-report-pilot/materials/瀹氱", final],
  ["../../../audit-report-pilot/materials/鐢靛瓙搴曠", papers],
])
const root = path.join(auto, "task-packs", "real-long-tasks", "audit-point-learnbench")
const testSpec = path.join(root, "test-instances.json")
const out = path.join(auto, "runtime-state", "audit-point-testsets", stamp())
const runRoot = path.join(auto, "runtime-state", "multi-instance-runs")
const limit = Number.parseInt(process.env.AUDIT_POINT_TEST_CONCURRENCY ?? "5", 10)
const rounds = Number.parseInt(process.env.AUDIT_POINT_TEST_ROUNDS ?? "2", 10)
const groups = new Set(
  (process.env.AUDIT_POINT_TEST_GROUPS ?? "reproduce,discovery")
    .split(",")
    .map((it) => it.trim())
    .filter(Boolean),
)

function stamp() {
  const d = new Date()
  const p = (v: number, w = 2) => String(v).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

async function merged() {
  const dir = path.join(auto, "runtime-state", "audit-point-batches")
  const rows = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const got = rows.filter((it) => it.isDirectory()).map((it) => path.join(dir, it.name)).sort().reverse()
  for (const row of got) {
    const file = path.join(row, "merge-output.json")
    if (!(await pathExists(file))) continue
    const raw = JSON.parse(await readFile(file, "utf8")) as { mergedSkillDir?: string }
    if (raw.mergedSkillDir && (await pathExists(raw.mergedSkillDir))) return raw.mergedSkillDir
  }
  throw new Error("No usable merged skill found in runtime-state/audit-point-batches/*/merge-output.json")
}

function fixSpec(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value
    for (const [bad, good] of pathFixes) {
      out = out.replaceAll(bad, good)
    }
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => fixSpec(item))
  }
  if (!value || typeof value !== "object") {
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, fixSpec(val)]))
}

function forceSharedPaths(spec: Record<string, unknown>) {
  const materials = Array.isArray(spec.materials) ? spec.materials : []
  if (materials[0] && typeof materials[0] === "object") {
    ;(materials[0] as Record<string, unknown>).path = final
  }
  if (materials[1] && typeof materials[1] === "object") {
    ;(materials[1] as Record<string, unknown>).path = papers
  }
  const graph = spec.initialGraph
  if (!graph || typeof graph !== "object") return spec
  const units = Array.isArray((graph as Record<string, unknown>).units) ? (graph as Record<string, unknown>).units : []
  const head = units[0]
  if (!head || typeof head !== "object") return spec
  const unit = head as Record<string, unknown>
  if (!Array.isArray(unit.inputs) || unit.inputs.length < 2) return spec
  unit.inputs[0] = final
  unit.inputs[1] = papers
  return spec
}

async function prep(item: Item) {
  if (item.mode !== "discovery") return path.join(root, "tasks", item.id)
  const src = path.join(root, "tasks", item.id)
  const dst = path.join(out, "discovery-shadow", item.id)
  await cp(src, dst, { recursive: true, force: true })
  const instruction = path.join(dst, "instruction.md")
  const guidance = path.join(dst, "human-guidance.md")
  const a = [
    `# Human Guidance - ${item.id}`,
    "",
    "这是发现型测试：不要复述答案句，不要先验匹配。",
    "你必须从共享材料中独立定位证据，产出一条可执行审核意见。",
    "重点：同类问题识别、证据定位、可执行纠正建议。",
    "约束：只输出一条审核意见到 workspace/audit-point-output.md。",
    "",
  ].join("\n")
  await writeFile(instruction, a, "utf8")
  await writeFile(guidance, a, "utf8")
  const specPath = path.join(dst, "spec.json")
  if (await pathExists(specPath)) {
    const raw = await readFile(specPath, "utf8")
    let text = raw.replace(/^\uFEFF/, "")
    for (const [bad, good] of rawFixes) {
      text = text.replaceAll(bad, good)
    }
    if (text !== raw) {
      await writeFile(specPath, text, "utf8")
    }
    const spec = JSON.parse(text) as Record<string, unknown>
    const fixed = forceSharedPaths(fixSpec(spec) as Record<string, unknown>)
    const validators = Array.isArray(fixed.validators) ? fixed.validators : []
    const next = validators.map((row) => {
      if (!row || typeof row !== "object") return row
      const val = row as Record<string, unknown>
      if (String(val.id ?? "") !== "single-point-soft-validate") return val
      const extra = [
        "Discovery-mode acceptance is enabled for this test instance.",
        "If candidate does not match hidden answer issue but presents a valid high-severity audit issue from shared materials, set valid_new_issue=true.",
        "For discovery mode, pass=true when: (same_issue=true AND specific_evidence=true AND actionable=true) OR (valid_new_issue=true AND specific_evidence=true AND actionable=true).",
        "Include field valid_new_issue (boolean) in result.",
      ].join("\n")
      const prompt = `${String(val.prompt ?? "").trim()}\n${extra}`
      return { ...val, prompt }
    })
    await writeFile(specPath, JSON.stringify({ ...fixed, validators: next }, null, 2), "utf8")
  }
  return dst
}

async function runOne(input: {
  kind: Group["name"]
  rows: Item[]
  mergedSkillDir: string
}) {
  const id = `audit-point-${input.kind}-test-${Date.now()}`
  const dir = path.join(runRoot, id)
  const instances = await Promise.all(
    input.rows.map(async (row) => ({
      id: row.id,
      sourceTaskRoot: await prep(row),
      engine: "skillsbench" as const,
      skillsbenchRoot: root,
      taskID: row.id,
      role: "test" as const,
    })),
  )
  const state = await createCoordinatorRun({
    cwd,
    runRoot: dir,
    label: `audit-point-${input.kind}-test`,
    rounds,
    instances,
    fanoutLimit: limit,
  })
  state.mergedSkillDir = input.mergedSkillDir
  await saveCoordinatorState(state)
  await appendCoordinatorLog(state, "info", `Testset ${input.kind} start: ${instances.map((v) => v.id).join(", ")}`)
  const res = await runCoordinatorPhase3Validate({
    cwd,
    state,
    rounds,
    validateLimit: limit,
    filter: (instance) => instance.role === "test",
  })
  return { id: state.id, runRoot: dir, kind: input.kind, result: res }
}

async function main() {
  await mkdir(out, { recursive: true })
  await cp(path.join(root, "seed-expert-workspace"), path.join(out, "seed-expert-workspace"), {
    recursive: true,
    force: true,
  })
  const spec = JSON.parse(await readFile(testSpec, "utf8")) as Spec
  const mergedSkillDir = await merged()
  const map = new Map(spec.instances.map((it) => [it.id, it]))
  const plan = spec.groups.filter((group) => groups.has(group.name)).map((group) => ({
    group,
    rows: group.instanceIDs.map((id) => map.get(id)).filter((v): v is Item => !!v),
  }))
  const results = []
  for (const item of plan) {
    const row = await runOne({ kind: item.group.name, rows: item.rows, mergedSkillDir })
    results.push(row)
  }
  await writeFile(path.join(out, "test-results.json"), JSON.stringify(results, null, 2), "utf8")
  console.log(`TESTSET_RUN_ROOT=${out}`)
  console.log(JSON.stringify(results, null, 2))
}

await main()
