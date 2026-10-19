import path from "node:path"
import { readFile, realpath, mkdir, open, access } from "node:fs/promises"
import { prepareEntry, validateEntry } from "./entry"
import { selectedRuntime } from "./selected-runtime"
import { copyCandidate, readCandidate } from "./candidate"
import { canonical, fingerprint } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import type { Runtime } from "./runtime"
import type { CoordinatorState } from "../multi-instance/contract"
import type { ProtocolMergeConfig } from "./merge-stage"
import { loadLongTaskSpec } from "../long-task/spec"
import { restoreTaskContext, taskBudgetOptions } from "../task-adaptation/context"
import { readTaskVersions, selectTaskVersion } from "../task-adaptation/selection"
import { exportTaskDelivery } from "../task-adaptation/delivery"
import { readTaskExplorationDecision } from "../task-adaptation/exploration/lifecycle"
import { authorContext } from "./author-context"

async function read(file: string) { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) }

export async function harvest(input: { cwd: string; campaignRoot: string; taskID: string; targetRoot: string }, injected?: Runtime) {
  if (![input.campaignRoot, input.targetRoot].every(path.isAbsolute)) throw new Error("Absolute harvest paths required")
  const root = await realpath(input.campaignRoot)
  const target = path.relative(root, path.resolve(input.targetRoot))
  if (!target.startsWith(`..${path.sep}`) && target !== ".." && !path.isAbsolute(target)) throw new Error("Harvest cannot modify source campaign")
  const inside = async (file: string) => {
    if (!path.isAbsolute(file)) throw new Error("Absolute acceptance evidence required")
    const resolved = await realpath(file)
    const relative = path.relative(root, resolved)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Acceptance evidence outside campaign")
    return resolved
  }
  const snapshot = await read(path.join(root, "protocol-plugins", "entry.snapshot.json"))
  const entry = validateEntry(snapshot.entry)
  if (entry.taskID !== input.taskID || entry.phase !== "source") throw new Error("Source harvest entry mismatch")
  const state = await read(path.join(root, "campaign.json"))
  let selected: { result: string; candidate: string; round: number } | undefined
  const saved = await read(path.join(root, "task-adaptation/task-plan.snapshot.json")).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return undefined
  })
  // 收集也沿用原预算身份，否则后端指纹会与正式receipt不一致。
  const budgets = saved?.plan?.exploration ? await taskBudgetOptions((await loadLongTaskSpec(state.baseSpecPath)).spec) : {}
  const runtime = injected ?? await selectedRuntime(path.join(root, "protocol-backends"), input.cwd, entry, undefined, budgets)
  const prepared = await prepareEntry(root, entry, runtime)
  if (!prepared) throw new Error("Frozen source entry required")
  if (saved?.plan?.exploration) {
    if (state.status !== "verified_success" || !state.selectedTaskVersionPath) throw new Error("Selected source delivery missing")
    const spec = (await loadLongTaskSpec(state.baseSpecPath)).spec
    spec.taskAdaptationContext = await restoreTaskContext(spec, saved)
    // 停止决定绑定原协议，磁盘spec不包含运行时作者上下文。
    spec.protocolAuthorContext = authorContext(entry, prepared.protocol, prepared.project)
    const choice = await selectTaskVersion(spec, { root, round: state.currentRound, maxRounds: state.maxRounds, readonly: true })
    const decision = await readTaskExplorationDecision(spec, { root, round: state.currentRound })
    if (!choice.passed || choice.selectedTaskVersionPath !== state.selectedTaskVersionPath ||
        decision.action !== "finish" || decision.reason !== state.taskStopReason) throw new Error("Selected source state drift")
    const version = (await readTaskVersions(spec, root)).find(item => item.path === state.selectedTaskVersionPath)
    if (!version || !version.record.feedback.endsWith(".training.json")) throw new Error("Selected source version missing")
    const dir = `${input.targetRoot}.verified-delivery`
    await exportTaskDelivery(spec, { root, selectedTaskVersionPath: version.path, dir })
    // 下游只读选定合格版本，末轮拒绝不能让它退回current。
    selected = { result: version.record.feedback.slice(0, -".training.json".length),
      candidate: path.join(dir, "files"), round: version.record.round }
  }
  if (state.status !== "verified_success" || !selected && state.lastFinalAcceptancePassed !== true) throw new Error("Source campaign not accepted")
  const resultPath = await inside(selected?.result ?? state.lastFinalAcceptanceResultPath)
  const result = await read(resultPath)
  if (result.passed !== true || result.acceptanceMode !== "protocol_plugins" || result.campaignID !== state.id ||
      result.roundNumber !== (selected?.round ?? state.currentRound) || !selected && result.runID !== state.lastRunID) throw new Error("Actual protocol acceptance identity required")
  const candidateRoot = selected?.candidate ?? await inside(result.validationPackageRoot)
  const receiptPath = await inside(result.protocolReceiptPath)
  const receipt = await read(receiptPath)
  const candidate = await readCandidate(candidateRoot, prepared.project.pack.skill)
  await access(await inside(path.join(path.dirname(receiptPath), "protocol.started.claim")))
  const task = prepared.project.pack.tasks.find((item) => item.id === input.taskID)!
  const expected = [candidate.metadata.map(({ id, kind, bytes, sha256 }) => ({ id, kind, length: bytes, sha256 })),
    ...[task.materials, task.privateInputs].map((files) => files.map((file) => {
      const artifact = prepared.project.artifacts.find((item) => item.path === file.path)!
      return { id: file.id, kind: file.kind, length: artifact.bytes, sha256: artifact.sha256 }
    }))].map((files) => files.sort((a, b) => a.id.localeCompare(b.id)))
  const plan = prepared.protocol.selection.protocol.phases.source!
  // 收集只依赖来源验收，不要求以后一定执行合并。
  if (path.basename(receiptPath) !== "protocol.receipt.json" || receipt.schema !== "aev.protocol-receipt.v1" ||
      receipt.task !== input.taskID || receipt.phase !== "source" || receipt.status !== "passed" ||
      receipt.protocolFingerprint !== prepared.protocol.fingerprint || receipt.claim !== plan.claim ||
      receipt.executed !== (plan.claim === "task_execution") ||
      canonical([receipt.evidence?.skill, receipt.evidence?.materials, receipt.evidence?.privateInputs]) !== canonical(expected)) {
    throw new Error("Source receipt and candidate identity mismatch")
  }
  const binding = { schema: "aev.protocol-harvest.v1", parentRunRoot: root, entry,
    projectFingerprint: prepared.project.fingerprint, protocolFingerprint: prepared.protocol.fingerprint,
    resultPath, resultFingerprint: fingerprint(result), receiptPath, receiptFingerprint: fingerprint(receipt),
    candidateFingerprint: candidate.fingerprint, targetRoot: input.targetRoot }
  await mkdir(input.targetRoot, { recursive: true })
  if (await realpath(input.targetRoot) !== path.resolve(input.targetRoot)) throw new Error("Harvest target link rejected")
  const evidence = input.targetRoot + ".protocol-harvest"
  await mkdir(evidence, { recursive: true })
  if (await realpath(evidence) !== path.resolve(evidence)) throw new Error("Harvest evidence link rejected")
  const file = path.join(evidence, "harvest.snapshot.json")
  try {
    const claim = await open(path.join(evidence, "harvest.started.claim"), "wx")
    await claim.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const previous = await read(file)
    if (canonical(previous) !== canonical(binding) ||
        (await readCandidate(input.targetRoot, prepared.project.pack.skill)).fingerprint !== candidate.fingerprint) {
      throw new Error("Harvest source or copied candidate drift")
    }
    return { candidateRoot: input.targetRoot, receiptPath, entry, parentRunRoot: root }
  }
  await copyCandidate(candidateRoot, input.targetRoot, prepared.project.pack.skill)
  if ((await readCandidate(candidateRoot, prepared.project.pack.skill)).fingerprint !== candidate.fingerprint) {
    throw new Error("Source candidate changed during harvest")
  }
  await writeJsonAtomic(file, binding)
  return { candidateRoot: input.targetRoot, receiptPath, entry, parentRunRoot: root }
}

export async function collectMergeConfig(state: CoordinatorState, author: ProtocolMergeConfig["author"]): Promise<ProtocolMergeConfig> {
  const eligible = state.instances.filter((row) => row.role !== "test" && row.status === "passed")
  if (!eligible.length) throw new Error("No accepted protocol sources to merge")
  const sources = []
  let first: { root: string; entry: ReturnType<typeof validateEntry>; project: string; protocol: string } | undefined
  for (const row of eligible) {
    if (!row.campaignDir || !row.harvestedSkillPath || !row.harvestedProtocolReceiptPath) {
      throw new Error("Protocol source harvest evidence missing")
    }
    const saved = await read(path.join(row.campaignDir, "protocol-plugins", "entry.snapshot.json"))
    const entry = validateEntry(saved.entry)
    if (entry.phase !== "source" || entry.taskID !== row.id) throw new Error("Collected source task identity mismatch")
    if (!first) first = { root: row.campaignDir, entry, project: saved.projectFingerprint, protocol: saved.protocolFingerprint }
    if (saved.projectFingerprint !== first.project || saved.protocolFingerprint !== first.protocol) {
      throw new Error("Cannot mix source project or protocol identities")
    }
    sources.push({ id: row.id, candidateRoot: row.harvestedSkillPath, receiptPath: row.harvestedProtocolReceiptPath })
  }
  return { parentRunRoot: first!.root, entry: first!.entry, sources, author: structuredClone(author) }
}
