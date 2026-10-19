import { readFile } from "node:fs/promises"
import path from "node:path"
import type { LongTaskSpec } from "../../long-task/contract"
import { checkedPath } from "../../file-transaction"
import { openGeneration } from "./activation"
import { assertTaskCampaignControl, type TaskCampaignControl } from "./ownership"
import { explorationPolicy } from "./policy"

const active = new WeakMap<object, { root: string; control: TaskCampaignControl }>()
export type TaskGenerationLease = Awaited<ReturnType<typeof openTaskGeneration>>

export function assertTaskGeneration(spec: LongTaskSpec, lease?: TaskGenerationLease) {
  if (!spec.taskAdaptationContext?.plan.exploration) return
  const held = lease && active.get(lease)
  // spec可落盘，实际持锁授权不可序列化或由直接入口伪造。
  if (!held || spec.taskAdaptationContext.fingerprint !== held.control.scope.plan ||
      spec.taskAdaptationCampaignRoot !== held.root) throw new Error("Exploration inner run requires live Campaign generation lease")
  assertTaskCampaignControl(held.control, held.root)
}

export async function openTaskGeneration(spec: LongTaskSpec, input: {
  root: string
  control: TaskCampaignControl
}) {
  assertTaskCampaignControl(input.control, input.root)
  const bound = spec.taskAdaptationContext
  if (!bound || bound.fingerprint !== input.control.scope.plan) throw new Error("Generation task binding mismatch")
  const cfg = explorationPolicy(bound.plan.exploration, bound.plan)!
  const root = path.join(input.root, "task-adaptation/exploration/activation")
  let generation: 0 | 1 = 0
  try {
    const file = path.join(root, "activation.json")
    if ((await checkedPath(file, "file")).size > cfg.bounds.archiveBytes) throw new Error("Activation exceeds capacity")
    const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    if (saved.record?.generation !== 1) throw new Error("Invalid active generation")
    generation = 1
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  // 整轮持有租约，清理结束后才允许切换工作版本。
  const lease = await openGeneration({ root, scope: input.control.scope, generation, cap: cfg.bounds.archiveBytes })
  const result = { ...lease, generation, close() { active.delete(result); lease.close() } }
  active.set(result, { root: input.root, control: input.control })
  return result
}
