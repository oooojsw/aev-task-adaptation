import path from "node:path"
import { mkdir, readFile } from "node:fs/promises"
import type { LongTaskSpec } from "../../long-task/contract"
import type { LongTaskCampaignState } from "../../long-task-campaign/contract"
import { checkedPath, directoryBytes, openFileTransaction } from "../../file-transaction"
import { identifyProcessOwner, strongProcessOwnerHints, optionalProcessOwnerHints } from "../../process-identity"
import { canonical, immutable } from "../../protocol-plugins/identity"
import { writeJsonAtomic } from "../../atomic-write"
import { verifyBinding } from "../binding"
import { validateTaskBudgetPolicy } from "../budget-policy"
import { explorationIdentity, explorationPolicy } from "./policy"

export async function preserveExplorationRuntime(root: string, kind: "campaign" | "run") {
  if (kind === "campaign") {
    try {
      await checkedPath(path.join(root, "task-adaptation/exploration/host"), "directory")
      return true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  const file = path.join(root, kind === "campaign" ? "task-adaptation/task-plan.snapshot.json" : "task.json")
  try {
    if ((await checkedPath(file, "file")).size > 1048576) throw new Error("Runtime control metadata exceeds limit")
    const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    // 清理器只保守避让，不把存在声明当成能力或恢复许可。
    return (kind === "campaign" ? saved?.plan?.exploration : saved?.taskAdaptationContext?.plan?.exploration) !== undefined
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

export async function openTaskCampaignControl(spec: LongTaskSpec, input: {
  root: string
  campaign: string
  baseSpecPath: string
}) {
  const bound = spec.taskAdaptationContext
  if (!bound?.plan.exploration) return undefined
  const cfg = spec.taskAdaptation
  if (!cfg?.requestBudget || !path.isAbsolute(input.root) || !path.isAbsolute(input.baseSpecPath) ||
    !spec.taskAdaptationCampaignRoot || path.resolve(spec.taskAdaptationCampaignRoot) !== path.resolve(input.root) ||
    path.basename(input.root) !== input.campaign || !/^[a-f0-9]{64}$/.test(spec.protocolAuthorContext?.fingerprint ?? "")) {
    throw new Error("Frozen exploration Campaign control context required")
  }
  await verifyBinding(bound)
  const policy = explorationPolicy(bound.plan.exploration, bound.plan)!
  const budget = validateTaskBudgetPolicy(cfg.requestBudget)
  const scope = { campaign: input.campaign, plan: bound.fingerprint,
    policy: explorationIdentity(policy, bound.plan)!, protocol: spec.protocolAuthorContext!.fingerprint,
    budget: { root: budget.root, scope: budget.scope } }
  await checkedPath(input.root, "directory")
  let root = input.root
  for (const name of ["task-adaptation", "exploration", "host"]) {
    await checkedPath(root, "directory")
    root = path.join(root, name)
    await mkdir(root).catch(error => { if (error.code !== "EEXIST") throw error })
    await checkedPath(root, "directory")
  }
  const lease = await openFileTransaction(root, "campaign", policy.bounds.archiveBytes)
  try {
    // 取得排他权后重读归属，锁前看板不能授权恢复或写入。
    const file = path.join(input.root, "campaign.json")
    if ((await checkedPath(file, "file")).size > 1048576) throw new Error("Campaign control state exceeds limit")
    const state = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as LongTaskCampaignState
    if (!state || state.id !== input.campaign || typeof state.baseSpecPath !== "string" ||
      path.resolve(state.baseSpecPath) !== path.resolve(input.baseSpecPath)) throw new Error("Campaign control identity drift")
    if (state.ownerPID !== undefined) {
      if (!Number.isSafeInteger(state.ownerPID) || state.ownerPID < 1) throw new Error("Campaign owner identity malformed")
      const owner = await identifyProcessOwner({ pid: state.ownerPID, expectedCreationTick: state.ownerCreationTick,
        requiredAnyCommandHints: strongProcessOwnerHints([state.ownerCommandHint, input.root, input.baseSpecPath]),
        optionalCommandHints: optionalProcessOwnerHints([state.ownerCommandHint]) })
      // 未确认结束的旧owner不能靠心跳年龄解除，更不能在此杀进程。
      if (owner.alive && owner.ownership !== "wrong_owner" && owner.pid !== process.pid) {
        throw new Error("Campaign owner still active or unresolved; recovery not authorized")
      }
    }
    const binding = { schema: "aev.exploration-host-scope.v1", root: path.resolve(input.root).replaceAll("\\", "/"),
      baseSpecPath: path.resolve(input.baseSpecPath).replaceAll("\\", "/"), scope }
    const target = path.join(root, "scope.json")
    try {
      if ((await checkedPath(target, "file")).size > policy.bounds.archiveBytes) throw new Error("Host scope exceeds limit")
      if (canonical(JSON.parse((await readFile(target, "utf8")).replace(/^\uFEFF/, ""))) !== canonical(binding)) {
        throw new Error("Campaign Host scope drift")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if ((await directoryBytes(root)) + Buffer.byteLength(JSON.stringify(binding, null, 2) + "\n") > policy.bounds.archiveBytes) {
        throw new Error("Campaign Host control capacity exceeded")
      }
      await writeJsonAtomic(target, binding)
    }
    return { state: immutable(state), scope: immutable(scope), close: lease.rollback }
  } catch (error) {
    lease.rollback()
    throw error
  }
}
