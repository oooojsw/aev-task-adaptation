import path from "node:path"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
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

const cwd = path.resolve(import.meta.dir, "..", "..")
const auto = path.join(cwd, "auto-evolve")
const mats = path.join(auto, "task-packs", "real-long-tasks", "audit-report-pilot", "materials")
const final = path.join(mats, "定稿")
const papers = path.join(mats, "电子底稿")
const rawFixes = new Map<string, string>([
  ["../../../audit-report-pilot/materials/鐎规氨顭?", "../../../audit-report-pilot/materials/瀹氱"],
  ["../../../audit-report-pilot/materials/閻㈤潧鐡欐惔鏇狀焾", "../../../audit-report-pilot/materials/鐢靛瓙搴曠"],
])
const pathFixes = new Map<string, string>([
  ["../../../audit-report-pilot/materials/瀹氱", final],
  ["../../../audit-report-pilot/materials/鐢靛瓙搴曠", papers],
  ["../../../audit-report-pilot/materials/鐎规氨顭?", final],
  ["../../../audit-report-pilot/materials/閻㈤潧鐡欐惔鏇狀焾", papers],
])
const root = path.join(auto, "task-packs", "real-long-tasks", "audit-point-learnbench")
const testSpec = path.join(root, "test-instances.json")
const out = path.join(auto, "runtime-state", "audit-point-testsets", stamp())
const runRoot = path.join(auto, "runtime-state", "multi-instance-runs")
const limit = Number.parseInt(process.env.AUDIT_POINT_TEST_CONCURRENCY ?? "5", 10)
const rounds = Number.parseInt(process.env.AUDIT_POINT_TEST_ROUNDS ?? "1", 10)
const groups = new Set(
  (process.env.AUDIT_POINT_TEST_GROUPS ?? "all")
    .split(",")
    .map((it) => it.trim())
    .filter(Boolean),
)
const prepOnly = process.env.AUDIT_POINT_TEST_PREP_ONLY === "1"

function stamp() {
  const d = new Date()
  const p = (v: number, w = 2) => String(v).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

async function merged() {
  const env = process.env.AUDIT_POINT_MERGED_SKILL_DIR
  if (env && (await pathExists(env))) return env

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
    let next = value
    for (const [bad, good] of pathFixes) next = next.replaceAll(bad, good)
    return next
  }
  if (Array.isArray(value)) return value.map((item) => fixSpec(item))
  if (!value || typeof value !== "object") return value
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

function focusFromAnswer(raw: string) {
  const match = raw.match(/## Focus\s+([\s\S]*?)(?:\n## |\s*$)/)
  const focus = match?.[1]?.trim()
  return focus && !/Hidden Expert Answer/i.test(focus) ? focus : "Follow the task focus in the merged skill and shared materials."
}

function fixGuidance(id: string, focus: string) {
  return [
    `# Human Guidance - ${id}`,
    "",
    "This is a targeted-blind evaluation run.",
    "",
    "Audit focus:",
    focus,
    "",
    "You may use all shared materials and the merged skill in expert-workspace, but you must not assume hidden answers.",
    "Produce exactly one audit opinion item in workspace/audit-point-output.md.",
    "Do not create, repair, or evaluate a skill package in this test run.",
    "The opinion must include the audit issue, cause/context, concrete evidence, and an actionable recommendation.",
    "",
  ].join("\n")
}

function outputOnlySpec(spec: Record<string, unknown>, focus: string) {
  spec.goal = `Targeted-blind evaluation: use the merged skill and shared materials to produce exactly one audit opinion item for this audit focus: ${focus}`
  spec.targetPaths = [
    {
      path: "./workspace/audit-point-output.md",
      label: "candidate audit opinion",
      role: "output",
    },
  ]
  spec.editablePaths = ["./workspace"]
  spec.initialExpertContextPaths = []
  spec.formalPackageRoots = []
  const graph = spec.initialGraph
  if (graph && typeof graph === "object") {
    const obj = graph as Record<string, unknown>
    obj.completion_validator_ids = ["single-point-soft-validate"]
    obj.planner_summary =
      "Targeted-blind test: use the merged skill and shared materials to write exactly one audit opinion item, then validate only that opinion."
    const units = Array.isArray(obj.units) ? obj.units : []
    for (const row of units) {
      if (!row || typeof row !== "object") continue
      const unit = row as Record<string, unknown>
      if (String(unit.id ?? "") !== "write-single-point-skill-and-output") continue
      unit.title = "Write Single Point Audit Opinion"
      unit.goal =
        "Using the provided merged skill and shared materials, write exactly one professional audit opinion item to workspace/audit-point-output.md. Do not create or repair a skill package."
      unit.inputs = ["./workspace/material-notes.md", "./expert-workspace/INDEX.md", "./expert-workspace/CORE.md"]
      unit.expected_artifacts = ["./workspace/audit-point-output.md"]
      unit.claim = "The one-point audit opinion output is complete."
      unit.check_plan =
        "The output must contain one actionable audit opinion item with issue, cause/context, concrete evidence, and requested correction/check."
      unit.validator_ids = []
    }
  }
  return spec
}

async function prep(item: Item) {
  const src = path.join(root, "tasks", item.id)
  const dst = path.join(out, "test-shadow", item.id)
  await cp(src, dst, { recursive: true, force: true })

  const srcAnswer = path.join(dst, "answer", "answer.md")
  const answerRaw = (await pathExists(srcAnswer)) ? await readFile(srcAnswer, "utf8") : ""
  const answerDir = path.join(out, "private-answers", item.id)
  const answerPath = path.join(answerDir, "answer.md")
  await mkdir(answerDir, { recursive: true })
  if (answerRaw) await writeFile(answerPath, answerRaw, "utf8")
  await rm(path.join(dst, "answer"), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.join(dst, "workspace"), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.join(dst, "expert-workspace"), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.join(dst, "validation-expert-workspace"), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.join(dst, "validate-run"), { recursive: true, force: true }).catch(() => undefined)

  const instruction = path.join(dst, "instruction.md")
  const guidance = path.join(dst, "human-guidance.md")
  const focus = focusFromAnswer(answerRaw)
  const text = fixGuidance(item.id, focus)
  await writeFile(instruction, text, "utf8")
  await writeFile(guidance, text, "utf8")

  const specPath = path.join(dst, "spec.json")
  if (await pathExists(specPath)) {
    const raw = await readFile(specPath, "utf8")
    let data = raw.replace(/^\uFEFF/, "")
    for (const [bad, good] of rawFixes) data = data.replaceAll(bad, good)
    const spec = JSON.parse(data) as Record<string, unknown>
    const fixed = outputOnlySpec(forceSharedPaths(fixSpec(spec) as Record<string, unknown>), focus)

    const validators = Array.isArray(fixed.validators) ? fixed.validators : []
    const next = validators
      .filter((row) => !!row && typeof row === "object" && String((row as Record<string, unknown>).id ?? "") === "single-point-soft-validate")
      .map((row) => {
        if (!row || typeof row !== "object") return row
        const val = row as Record<string, unknown>
        const prompt = String(val.prompt ?? "")
        const patched = [
          prompt.trim(),
          "",
          "STRICT RULES:",
          "- This is an evaluation run, not a training run.",
          "- The candidate artifact is only workspace/audit-point-output.md.",
          "- Do not require manifest.md, change_log.md, surface_contract.json, or any skill-package layout file.",
          "- Judge whether the candidate audit opinion identifies the hidden expert issue and explains cause/context/evidence/actionability.",
          "- valid_new_issue must always be false in this dataset.",
          "- pass can be true only when same_issue=true, specific_evidence=true, actionable=true.",
          "- If issue does not match hidden answer, set pass=false.",
        ].join("\n")
        return {
          ...val,
          inputFiles: {
            candidatePath: "./workspace/audit-point-output.md",
            humanGuidancePath: "./human-guidance.md",
          },
          privateAnswerManifest: {
            mode: "test-shadow-sibling",
            id: item.id,
            note: "The hidden answer is intentionally not exposed in this spec. The validator resolves it from the private testset area.",
          },
          attachedFiles: [],
          rubric: {
            mode: "targeted-blind",
            passRule: "passed = same_issue && specific_evidence && actionable",
            requiredCandidate: "one audit opinion item with issue, cause/context, concrete evidence, and actionability",
          },
          prompt: patched,
        }
      })
      .filter(Boolean)

    await writeFile(specPath, JSON.stringify({ ...fixed, validators: next }, null, 2), "utf8")
  }

  const campaignPath = path.join(dst, "campaign.json")
  if (await pathExists(campaignPath)) {
    const raw = await readFile(campaignPath, "utf8")
    const data = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>
    const sg = data.surfaceGeneralization
    if (sg && typeof sg === "object" && !Array.isArray(sg)) {
      const row = sg as Record<string, unknown>
      data.surfaceGeneralization = {
        ...row,
        enabled: false,
      }
      await writeFile(campaignPath, JSON.stringify(data, null, 2), "utf8")
    }
  }

  return dst
}

async function runOne(input: {
  kind: string
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
  const rows = groups.has("none")
    ? []
    : groups.has("all")
      ? spec.instances
      : spec.instances.filter((item) => groups.has(item.mode) || groups.has(item.id))
  if (prepOnly) {
    const prepared = await Promise.all(rows.map((row) => prep(row)))
    await writeFile(
      path.join(out, "test-results.json"),
      JSON.stringify({ mode: "targeted-blind", prepOnly: true, prepared }, null, 2),
      "utf8",
    )
    console.log(`TESTSET_RUN_ROOT=${out}`)
    console.log(JSON.stringify({ mode: "targeted-blind", prepOnly: true, prepared }, null, 2))
    return
  }
  const mergedSkillDir = await merged()
  const results = []
  if (rows.length > 0) {
    const row = await runOne({ kind: "targeted-blind", rows, mergedSkillDir })
    results.push(row)
  }
  await writeFile(path.join(out, "test-results.json"), JSON.stringify(results, null, 2), "utf8")
  console.log(`TESTSET_RUN_ROOT=${out}`)
  console.log(JSON.stringify(results, null, 2))
}

await main()
