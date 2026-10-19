import { readFile } from "node:fs/promises"
import { validateAdaptation } from "../context"
import { validatePlan } from "../plan"
import path from "node:path"
import { loadLongTaskCampaignSpec } from "../../long-task-campaign/spec"

export async function requireBenchmarkCampaignExploration(campaign: string, expected: string, selectedDelivery: boolean) {
  const { spec } = await loadLongTaskCampaignSpec(campaign)
  // 老账本仍按固定spec计算身份，探索不得检查一份却执行另一份。
  await requireBenchmarkExploration(spec.baseSpecPath, selectedDelivery && path.resolve(spec.baseSpecPath) === path.resolve(expected))
}

export async function requireBenchmarkExploration(file: string, selectedDelivery: boolean) {
  let raw
  try { raw = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
  if (!raw.taskAdaptation) return
  const cfg = validateAdaptation(raw.taskAdaptation)
  const plan = validatePlan(JSON.parse((await readFile(cfg.planPath, "utf8")).replace(/^\uFEFF/, "")))
  // 旧合并入口尚未接选定成果时，训练前拒绝，不能降级读取current。
  if (plan.exploration && !selectedDelivery) throw new Error("Benchmark exploration requires protocol selected-delivery pipeline")
}
