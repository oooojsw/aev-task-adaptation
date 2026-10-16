import path from "node:path"
import { readFile, mkdir, open, realpath, access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { writeJsonAtomic, writeFileAtomic } from "../atomic-write"
import { compile } from "../protocol-plugins/compile"
import type { Binding, Selection, PhaseProtocol } from "../protocol-plugins/contract"
import type { Registry } from "../protocol-plugins/registry"
import { fingerprint, canonical } from "../protocol-plugins/identity"
import { validateTraining, type TrainingConfig } from "../protocol-plugins/training"
import { loadPack } from "../protocol-plugins/project-pack"
import { bindPlan, verifyBinding, resolveResource } from "./binding"
import { validatePlan, type Plan } from "./plan"
import { verifyProtocolScopes } from "./protocol-scopes"

export interface ExecutionPreparation {
  root: string
  dir: string
  plan: Plan
  capabilities: string[]
  skillFormat: string
  productKind: string
  resourceKinds: Record<string, string>
  executor?: Binding
  checkers: Array<{ name: string; binding: Binding }>
  training: TrainingConfig
  maxBundleBytes: number
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const json = (bytes: Buffer) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))

export async function prepareExecution(input: ExecutionPreparation, registry: Registry) {
  const plan = validatePlan(input.plan)
  if (![input.root, input.dir].every(file => typeof file === "string" && path.isAbsolute(file)) ||
      !Number.isSafeInteger(input.maxBundleBytes) || input.maxBundleBytes < 1) throw new Error("Explicit bounded execution preparation required")
  const relation = path.relative(input.root, input.dir)
  if (!relation || (!path.isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${path.sep}`))) throw new Error("Execution bundle must be outside source materials")
  if (!input.resourceKinds || Object.keys(input.resourceKinds).length !== plan.resources.length ||
      plan.resources.some(item => typeof input.resourceKinds[item.id] !== "string" || !input.resourceKinds[item.id].trim())) throw new Error("Explicit resource kinds required")
  const missing = plan.acceptance.checks.filter(check => !input.checkers.some(item => item.name === check.id)).map(check => `checker:${check.id}`)
  if (plan.acceptance.execution !== "none" && !input.executor) missing.push("executor")
  if (missing.length) return { status: "missing_bindings" as const, missing }
  if (new Set(input.checkers.map(item => item.name)).size !== input.checkers.length ||
      input.checkers.some(item => !plan.acceptance.checks.some(check => check.id === item.name))) throw new Error("Unexpected or duplicate checker binding")
  if (plan.acceptance.execution === "none" && input.executor) throw new Error("Content-only task cannot add execution")
  const training = validateTraining(input.training)
  for (const check of plan.acceptance.checks) {
    if (check.mechanism === "active_judge" && input.checkers.find(item => item.name === check.id)!.binding.id !== "active-tool-judge") {
      throw new Error("Active source check requires active-tool-judge")
    }
  }
  const bound = await bindPlan(input.root, plan, input.capabilities)
  const entries = plan.deliverable.entries
  const split = (ids: string[]) => ({
    skill: ids.filter(id => entries.includes(id)),
    materials: ids.filter(id => !entries.includes(id) && plan.resources.find(item => item.id === id)!.audience === "public"),
    private: ids.filter(id => !entries.includes(id) && plan.resources.find(item => item.id === id)!.audience !== "public"),
  })
  const publicFiles = plan.resources.filter(item => !entries.includes(item.id) && item.audience === "public")
  const privateFiles = plan.resources.filter(item => !entries.includes(item.id) && item.audience !== "public")
  const kinds = [...new Set(publicFiles.map(item => input.resourceKinds[item.id]))]
  const project = { id: plan.id, version: "1", skillFormats: [input.skillFormat], productKinds: [input.productKind], materialKinds: kinds }
  const executionWindow = plan.windows.find(item => item.role === "independent" && item.stage === "accept")
  if (plan.acceptance.execution !== "none" && !executionWindow) throw new Error("Independent execution window required")
  const phase: PhaseProtocol = { claim: plan.acceptance.execution === "none" ? "skill_check" : "task_execution",
    ...(input.executor ? { executor: input.executor, executionInputs: {
      skill: split(executionWindow!.reads).skill, materials: split(executionWindow!.reads).materials } } : {}),
    checks: plan.acceptance.checks.map(check => {
      const scope = split(check.resources)
      return { ...input.checkers.find(item => item.name === check.id)!.binding, name: check.id,
        target: check.target === "candidate" ? "skill" : "product", stage: check.target === "candidate" ? "before_execution" : "after_execution",
        required: check.required, mechanism: check.mechanism === "active_judge" ? "judge" : check.mechanism,
        skillInputs: scope.skill, materialInputs: scope.materials, privateInputs: scope.private,
        feedback: check.feedback === "message" ? "checker_message" : "status_only" }
    }) }
  const selection: Selection = { schema: "aev.protocol-plugins.v1", project,
    protocol: { id: `${plan.id}-acceptance`, version: "1", phases: { source: phase } },
    run: { skillFormat: input.skillFormat, productKind: input.productKind, materialKinds: kinds } }
  const protocol = compile(selection, registry)
  const files = await Promise.all(bound.resources.map(async item => {
    const bytes = await readFile(item.path)
    return { id: item.id, relative: plan.resources.find(resource => resource.id === item.id)!.path, bytes, sha256: hash(bytes) }
  }))
  if (files.reduce((sum, item) => sum + item.bytes.length, 0) > input.maxBundleBytes) throw new Error("Execution bundle byte budget exceeded")
  if (files.some(item => item.relative.toLowerCase().split("/")[0] === ".aev-project.json")) throw new Error("Reserved project manifest path")
  await verifyBinding(bound)
  const binding = fingerprint({ input, source: hash(await readFile(fileURLToPath(import.meta.url))), protocol: protocol.fingerprint,
    files: files.map(({ bytes, ...item }) => ({ ...item, length: bytes.length })) })
  await mkdir(input.dir, { recursive: true })
  const dir = await realpath(input.dir)
  if (dir.toLowerCase() !== path.resolve(input.dir).toLowerCase()) throw new Error("Linked execution output rejected")
  const bundle = path.join(dir, "task-inputs")
  const paths = { planPath: path.join(dir, "task-plan.json"), selectionPath: path.join(dir, "selection.json"),
    projectManifestPath: path.join(bundle, ".aev-project.json"), specPath: path.join(dir, "spec.json") }
  const completed = path.join(dir, "execution-preparation.completed.json")
  let fresh = true
  try { const claim = await open(path.join(dir, "execution-preparation.started.claim"), "wx"); await claim.close() }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; fresh = false }
  if (!fresh) {
    // 完成配置只复用，半完成配置不得被自动覆盖。
    const saved = json(await readFile(await resolveResource(dir, "execution-preparation.completed.json")))
    const expectedPaths = [...Object.values(paths), ...files.map(item => path.join(bundle, item.relative))]
      .map(file => path.relative(dir, file).replaceAll("\\", "/")).sort()
    if (saved.binding !== binding || !Array.isArray(saved.artifacts) ||
        canonical(saved.artifacts.map((item: { path: string }) => item.path).sort()) !== canonical(expectedPaths)) throw new Error("Execution preparation identity drift")
    for (const item of saved.artifacts) {
      const bytes = await readFile(await resolveResource(dir, item.path))
      if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error("Prepared execution artifact drift")
    }
    return { status: "ready" as const, ...paths, reused: true }
  }
  for (const file of [...Object.values(paths), completed, bundle]) {
    try { await access(file); throw new Error("Unclaimed execution preparation files exist") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  await mkdir(bundle)
  for (const item of files) {
    const target = path.join(bundle, item.relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFileAtomic(target, item.bytes)
  }
  const packFile = (item: Plan["resources"][number]) => ({ id: item.id, kind: input.resourceKinds[item.id], path: item.path })
  await writeJsonAtomic(paths.projectManifestPath, { schema: "aev.project-pack.v1", project,
    skill: { format: input.skillFormat, entries: plan.resources.filter(item => entries.includes(item.id)).map(packFile) },
    tasks: [{ id: plan.id, split: "train", materials: publicFiles.map(packFile), privateInputs: privateFiles.map(packFile) }] })
  await verifyProtocolScopes(plan, bundle, await loadPack(paths.projectManifestPath), plan.id, phase)
  await writeJsonAtomic(paths.planPath, plan)
  await writeJsonAtomic(paths.selectionPath, selection)
  await writeJsonAtomic(paths.specPath, { title: plan.objective, goal: plan.objective, validators: [],
    materials: publicFiles.map(item => ({ label: item.id, path: path.join(bundle, item.path).replaceAll("\\", "/") })),
    protocolPlugins: { schema: "aev.protocol-entry.v1", selectionPath: paths.selectionPath.replaceAll("\\", "/"),
      projectManifestPath: paths.projectManifestPath.replaceAll("\\", "/"), taskID: plan.id, phase: "source" },
    protocolTraining: training, taskAdaptation: { schema: "aev.task-adaptation.v1", planPath: paths.planPath.replaceAll("\\", "/"),
      root: bundle.replaceAll("\\", "/"), capabilities: input.capabilities,
      entries: plan.resources.filter(item => entries.includes(item.id)).map(item => ({ id: item.id, path: item.path })) } })
  await verifyBinding(bound)
  for (const item of files) {
    // 冻结起点时连可变候选也核对，避免复制期间悄悄换版本。
    if (hash(await readFile(await resolveResource(input.root, item.relative))) !== item.sha256) throw new Error("Source changed during execution preparation")
  }
  const artifacts = await Promise.all([...Object.values(paths), ...files.map(item => path.join(bundle, item.relative))].map(async file => {
    const bytes = await readFile(file)
    return { path: path.relative(dir, file).replaceAll("\\", "/"), sha256: hash(bytes), bytes: bytes.length }
  }))
  await writeJsonAtomic(completed, { schema: "aev.execution-preparation.v1", binding, artifacts })
  return { status: "ready" as const, ...paths, reused: false }
}
