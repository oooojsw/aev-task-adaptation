import { createHash } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { LongTaskSpec } from "../long-task/contract"
import { fingerprint, canonical } from "../protocol-plugins/identity"
import { productEvidenceName } from "../protocol-plugins/runtime"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { resolveResource, verifyBinding } from "./binding"
import { taskFeedback } from "./feedback"
import { storeVersion } from "./version-store"
import { checkedPath } from "../file-transaction"
import { recoverMaterialization, readMaterialized } from "./exploration/materialize"

export interface Version {
  schema: "aev.task-version.v1"
  plan: string
  receipt: string
  feedback: string
  round: number
  metric: number | null
  files: Array<{ id: string; entry: string; file: string; sha256: string; bytes: number }>
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const parse = async (file: string) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))

export async function taskSelectionSource(spec: LongTaskSpec, root: string, feedback: string, options?: { readonly?: boolean }) {
  const bound = spec.taskAdaptationContext
  const entry = spec.protocolPlugins
  if (!bound || !entry) throw new Error("Frozen task selection context required")
  const view = await taskFeedback(bound, { root, path: feedback, task: entry.taskID, phase: entry.phase }, options).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Task selection evidence missing")
    throw error
  })
  if (view.view.status !== "passed") throw new Error("Only passed candidates may enter delivery selection")
  let metric: number | null = null
  if (bound.plan.selection.rule === "best_pass") {
    const receipt = await parse(await resolveResource(root,
      path.relative(root, path.join(path.dirname(feedback), "protocol.receipt.json")).replaceAll("\\", "/")))
    if (!receipt.product) throw new Error("Metric selection requires an executed product")
    const file = await resolveResource(root, path.relative(root, path.join(path.dirname(feedback),
      productEvidenceName(receipt.product.kind))).replaceAll("\\", "/"))
    const bytes = await readFile(file)
    if (hash(bytes) !== receipt.product.sha256 || bytes.length !== receipt.product.length) throw new Error("Selection public product evidence drift")
    const product = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
    const key = bound.plan.selection.metric!
    // 仅取正式检查通过的实际产物指标，不采纳作者自报分数。
    if (!product || typeof product !== "object" || !Object.hasOwn(product, key) ||
      typeof product[key] !== "number" || !Number.isFinite(product[key])) throw new Error("Selection metric missing or nonfinite")
    metric = product[key]
  }
  return { view: view.view, metric }
}

export async function readTaskVersions(spec: LongTaskSpec, root: string, options?: { readonly?: boolean }) {
  const bound = spec.taskAdaptationContext
  if (!spec.taskAdaptation || !bound) return []
  await verifyBinding(bound)
  const folder = path.join(root, "task-adaptation/versions")
  let names: string[]
  try { names = await readdir(folder) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const versions: Array<{ record: Version; path: string }> = []
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("Unexpected task version entry")
    const file = await resolveResource(root, `task-adaptation/versions/${name}/record.json`)
    const saved = await parse(file)
    const { fingerprint: savedHash, ...record } = saved as Version & { fingerprint: string }
    if (record.schema !== "aev.task-version.v1" || fingerprint(record) !== savedHash || record.plan !== bound.fingerprint ||
      record.receipt !== name || canonical(record.files.map(item => ({ id: item.id, path: item.entry }))) !==
      canonical(spec.taskAdaptation.entries)) throw new Error("Saved task version identity drift")
    const actual = await taskSelectionSource(spec, root, record.feedback, options)
    if (actual.view.receiptFingerprint !== name || actual.view.round !== record.round || actual.metric !== record.metric) {
      throw new Error("Saved task version receipt drift")
    }
    for (const [index, item] of record.files.entries()) {
      if (item.file !== `files/${index}.bin` || actual.view.candidate.find(candidate => candidate.id === item.id)?.sha256 !== item.sha256) {
        throw new Error("Saved task version candidate identity drift")
      }
      const bytes = await readFile(await resolveResource(root, `task-adaptation/versions/${name}/${item.file}`))
      if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error("Saved task version bytes drift")
    }
    versions.push({ record, path: file.replaceAll("\\", "/") })
  }
  return versions.sort((a, b) => a.record.round - b.record.round || a.record.receipt.localeCompare(b.record.receipt))
}

export async function recoverTaskVersions(spec: LongTaskSpec, input: { root: string; candidateRoot: string; cap: number }) {
  const bound = spec.taskAdaptationContext
  if (!spec.taskAdaptation || !bound || !path.isAbsolute(input.root) || !path.isAbsolute(input.candidateRoot) ||
    !Number.isSafeInteger(input.cap) || input.cap < 1) throw new Error("Explicit task version recovery context required")
  await verifyBinding(bound)
  if (canonical(spec.taskAdaptation.entries) !== canonical(bound.plan.deliverable.entries.map(id => ({ id,
    path: bound.plan.resources.find(resource => resource.id === id)!.path }))))
    throw new Error("Task version recovery entry mapping drift")
  const root = path.join(input.root, "task-adaptation"), folder = path.join(root, "version-intents")
  let names: string[]
  try { await checkedPath(folder, "directory"); names = await readdir(folder) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return readTaskVersions(spec, input.root)
  }
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unexpected task version recovery intent")
    const file = await resolveResource(root, `version-intents/${name}`)
    if ((await checkedPath(file, "file")).size > input.cap) throw new Error("Task version recovery intent capacity exceeded")
    const { fingerprint: saved, ...record } = await parse(file) as Version & { fingerprint: string }
    if (record.schema !== "aev.task-version.v1" || record.plan !== bound.fingerprint || record.receipt !== name.slice(0, -5) ||
      fingerprint(record) !== saved || !Array.isArray(record.files) ||
      canonical(record.files.map(item => ({ id: item.id, path: item.entry }))) !== canonical(spec.taskAdaptation.entries) ||
      !Number.isSafeInteger(record.round) || record.round < 1 || record.files.some((item, index) =>
        item.file !== `files/${index}.bin` || !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(item.sha256)) ||
      record.files.reduce((sum, item) => sum + item.bytes, 0) > input.cap) throw new Error("Task version recovery intent drift")
    const actual = await taskSelectionSource(spec, input.root, record.feedback)
    if (actual.view.round !== record.round || actual.view.receiptFingerprint !== record.receipt || actual.metric !== record.metric ||
      record.files.some(item => actual.view.candidate.find(candidate => candidate.id === item.id)?.sha256 !== item.sha256))
      throw new Error("Task version recovery receipt drift")
    const content: Buffer[] = []
    for (const item of record.files) {
      const bytes = await recoverMaterialization(root, path.join(root, "versions", record.receipt, item.file), item)
        ?? await readMaterialized(await resolveResource(input.candidateRoot, item.entry), item)
      if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error("Task version recovery source drift")
      content.push(bytes)
    }
    // 先修已声明本地快照再枚举正式版本，绝不重发已完成验收。
    await storeVersion({ root: input.root, record, content, cap: input.cap, recover: true })
  }
  return readTaskVersions(spec, input.root)
}

export function chooseTaskVersion(spec: LongTaskSpec, versions: Awaited<ReturnType<typeof readTaskVersions>>, round: number, maxRounds: number, forcedReason?: string) {
  const plan = spec.taskAdaptationContext!.plan
  let best = versions[0]
  for (const version of versions.slice(1)) {
    if (plan.selection.rule === "best_pass" && (plan.selection.direction === "min"
      ? version.record.metric! < best.record.metric! : version.record.metric! > best.record.metric!)) best = version
  }
  const reason = forcedReason ?? (plan.selection.rule === "first_pass" && best ? "first_pass"
    : round >= Math.min(maxRounds, plan.stop.rounds) ? "round_budget"
    : best && round - best.record.round >= plan.stop.stagnant ? "stagnant" : undefined)
  return { selectedTaskVersionPath: best?.path, taskStopReason: reason, stop: Boolean(reason), passed: Boolean(best) }
}

export async function selectTaskVersion(spec: LongTaskSpec, input: {
  root: string; round: number; maxRounds: number; forcedReason?: string; readonly?: boolean
}) {
  // 默认严格只读；旧入口须显式选择原反馈兼容行为，仍不恢复版本。
  return chooseTaskVersion(spec, await readTaskVersions(spec, input.root, { readonly: input.readonly ?? true }), input.round, input.maxRounds, input.forcedReason)
}

export async function recordTaskVersion(spec: LongTaskSpec, input: {
  root: string; candidateRoot: string; feedback?: string; passed: boolean; round: number; maxRounds: number
  snapshot?: { recover: boolean; cap: number }
}) {
  if (!spec.taskAdaptation || !spec.taskAdaptationContext) return undefined
  if (input.snapshot && input.passed) {
    if (!input.feedback) throw new Error("Passed task selection requires actual acceptance feedback")
    const actual = await taskSelectionSource(spec, input.root, input.feedback)
    if (actual.view.round !== input.round) throw new Error("Selection round mismatch")
    let existing = false
    try {
      await resolveResource(input.root, `task-adaptation/versions/${actual.view.receiptFingerprint}/record.json`)
      existing = (await readTaskVersions(spec, input.root)).some(version => version.record.receipt === actual.view.receiptFingerprint)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const files: Version["files"] = [], content: Buffer[] = []
    for (const [index, item] of spec.taskAdaptation.entries.entries()) {
      const bytes = await readFile(await resolveResource(input.candidateRoot, item.path)), sha256 = hash(bytes)
      if (actual.view.candidate.find(candidate => candidate.id === item.id)?.sha256 !== sha256)
        throw new Error("Candidate changed after acceptance")
      files.push({ id: item.id, entry: item.path, file: `files/${index}.bin`, sha256, bytes: bytes.length })
      content.push(bytes)
    }
    // 同一正式receipt保留首次合格轮次，不用后续复用反馈改写血统。
    if (!existing) await storeVersion({ root: input.root, record: { schema: "aev.task-version.v1", plan: spec.taskAdaptationContext.fingerprint,
      receipt: actual.view.receiptFingerprint, feedback: input.feedback, round: input.round, metric: actual.metric, files },
      content, ...input.snapshot })
  }
  let versions = await readTaskVersions(spec, input.root)
  if (input.passed) {
    if (!input.feedback) throw new Error("Passed task selection requires actual acceptance feedback")
    const actual = await taskSelectionSource(spec, input.root, input.feedback)
    const name = actual.view.receiptFingerprint
    if (actual.view.round !== input.round) throw new Error("Selection round mismatch")
    if (!versions.some(version => version.record.receipt === name)) {
      const files: Version["files"] = []
      const content: Buffer[] = []
      for (const [index, item] of spec.taskAdaptation.entries.entries()) {
        const bytes = await readFile(await resolveResource(input.candidateRoot, item.path))
        const sha256 = hash(bytes)
        if (actual.view.candidate.find(candidate => candidate.id === item.id)?.sha256 !== sha256) throw new Error("Candidate changed after acceptance")
        files.push({ id: item.id, entry: item.path, file: `files/${index}.bin`, sha256, bytes: bytes.length })
        content.push(bytes)
      }
      const dir = path.join(input.root, "task-adaptation/versions", name)
      await mkdir(path.dirname(dir), { recursive: true })
      // 不覆盖半完成快照；中断现场需核查，避免静默改写已验收版本。
      await mkdir(dir)
      await mkdir(path.join(dir, "files"))
      for (const [index, bytes] of content.entries()) await writeFileAtomic(path.join(dir, files[index].file), bytes)
      const record: Version = { schema: "aev.task-version.v1", plan: spec.taskAdaptationContext.fingerprint,
        receipt: name, feedback: input.feedback, round: input.round, metric: actual.metric, files }
      await writeJsonAtomic(path.join(dir, "record.json"), { ...record, fingerprint: fingerprint(record) })
      versions = await readTaskVersions(spec, input.root)
    }
  }
  return chooseTaskVersion(spec, versions, input.round, input.maxRounds)
}
