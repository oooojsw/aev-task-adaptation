import { createHash } from "node:crypto"
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { LongTaskSpec } from "../long-task/contract"
import { fingerprint, canonical } from "../protocol-plugins/identity"
import { productEvidenceName } from "../protocol-plugins/runtime"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { resolveResource, verifyBinding } from "./binding"
import { taskFeedback } from "./feedback"

interface Version {
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

async function source(spec: LongTaskSpec, root: string, feedback: string) {
  const bound = spec.taskAdaptationContext
  const entry = spec.protocolPlugins
  if (!bound || !entry) throw new Error("Frozen task selection context required")
  const view = await taskFeedback(bound, { root, path: feedback, task: entry.taskID, phase: entry.phase }).catch(error => {
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

export async function readTaskVersions(spec: LongTaskSpec, root: string) {
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
    const actual = await source(spec, root, record.feedback)
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

export async function recordTaskVersion(spec: LongTaskSpec, input: {
  root: string; candidateRoot: string; feedback?: string; passed: boolean; round: number; maxRounds: number
}) {
  if (!spec.taskAdaptation || !spec.taskAdaptationContext) return undefined
  let versions = await readTaskVersions(spec, input.root)
  if (input.passed) {
    if (!input.feedback) throw new Error("Passed task selection requires actual acceptance feedback")
    const actual = await source(spec, input.root, input.feedback)
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
