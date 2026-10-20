import path from "node:path"
import { access, lstat, mkdir, open, readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { withFileLock } from "../jsonl"
import { writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { loadLongTaskSpec } from "../long-task/spec"
import { longTaskCampaignPaths } from "../long-task-campaign/repository"
import { prepareTaskRun, type TaskRunPreparation } from "./prepare-task-run"
import { resolveResource } from "./binding"
import { restoreTaskContext } from "./context"
import { exportTaskDelivery } from "./delivery"
import type { runLongTaskCampaign, resumeLongTaskCampaign } from "../long-task-campaign/runner"

type Controller = { runLongTaskCampaign: typeof runLongTaskCampaign; resumeLongTaskCampaign: typeof resumeLongTaskCampaign }
const parse = async (root: string, file: string) => JSON.parse((await readFile(await resolveResource(root, file), "utf8")).replace(/^\uFEFF/, ""))

export async function runTask(input: TaskRunPreparation, dependencies?: {
  prepare?: typeof prepareTaskRun
  controller?: () => Promise<Controller>
  templates?: readonly import("./exploration/templates").HostExplorationTemplate[]
}) {
  // 新统一入口要求有限真实预算；旧准备入口仍可独立使用。
  if (!input.execution.requestBudget) throw new Error("Task launch requires an explicit shared request budget")
  const prepared = dependencies?.prepare
    ? await dependencies.prepare(input)
    : await prepareTaskRun(input, { templates: dependencies?.templates })
  if (prepared.status !== "ready") return prepared
  const plan = await parse(path.dirname(prepared.planPath), path.basename(prepared.planPath))
  const dir = path.join(input.execution.dir, "task-run")
  await mkdir(dir, { recursive: true })
  if (path.resolve(await realpath(dir)).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error("Linked task run rejected")
  const specBytes = await readFile(prepared.specPath)
  const campaign = { title: plan.objective, baseSpecPath: prepared.specPath, mode: "graph_iterative", maxRounds: plan.stop.rounds, seedTargets: [] }
  const binding = fingerprint({ input, campaign, spec: createHash("sha256").update(specBytes).digest("hex") })
  const specPath = path.join(dir, "campaign-spec.json")
  const start = await withFileLock(path.join(dir, "launch.lock"), async () => {
    let fresh = false
    try { const handle = await open(path.join(dir, "launch.started.claim"), "wx"); await handle.close(); fresh = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
    if (!fresh) {
      await resolveResource(dir, "launch.started.claim")
      if (canonical(await parse(dir, "launch.json")) !== canonical({ schema: "aev.task-launch.v1", binding }) ||
          canonical(await parse(dir, "campaign-spec.json")) !== canonical(campaign)) throw new Error("Task launch identity drift")
      // 尚未登记Campaign的启动现场不能自动重发，避免重复付费。
      const saved = await parse(dir, "campaign-binding.json")
      if (saved.binding !== binding || typeof saved.campaignID !== "string" ||
          !/^[a-zA-Z0-9_-]+$/.test(saved.campaignID)) throw new Error("Task Campaign binding drift")
      const actualRoot = longTaskCampaignPaths(input.intake.cwd, saved.campaignID).root
      if (path.resolve(saved.campaignDir) !== path.resolve(actualRoot)) throw new Error("Task Campaign location drift")
      const state = await parse(actualRoot, "campaign.json")
      if (state.id !== saved.campaignID || path.resolve(state.baseSpecPath) !== path.resolve(prepared.specPath)) throw new Error("Task Campaign state drift")
      return saved as { campaignID: string; campaignDir: string }
    }
    // 启动claim被单独删除也不能覆盖原归属并重开任务。
    for (const file of ["launch.json", "campaign-spec.json", "campaign-binding.json", "outcome.json"]) {
      try { await access(path.join(dir, file)); throw new Error("Unclaimed task launch evidence exists") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    await writeJsonAtomic(specPath, campaign)
    await writeJsonAtomic(path.join(dir, "launch.json"), { schema: "aev.task-launch.v1", binding })
    return undefined
  }, { timeoutMs: 1000, staleMs: Number.POSITIVE_INFINITY })
  const controller = await (dependencies?.controller ?? (() => import("../long-task-campaign/runner")))()
  const result = start
    ? await controller.resumeLongTaskCampaign({ cwd: input.intake.cwd, campaignID: start.campaignID, specPath })
    : await controller.runLongTaskCampaign({ cwd: input.intake.cwd, specPath, forceNew: true,
        onCreated: async created => { await writeJsonAtomic(path.join(dir, "campaign-binding.json"), { binding, ...created }) } })
  const registered = await parse(dir, "campaign-binding.json")
  if (registered.binding !== binding || registered.campaignID !== result.campaignID ||
      path.resolve(registered.campaignDir) !== path.resolve(result.campaignDir) ||
      path.resolve(result.campaignDir) !== path.resolve(longTaskCampaignPaths(input.intake.cwd, result.campaignID).root)) {
    throw new Error("Controller result differs from registered task Campaign")
  }
  let delivery: Awaited<ReturnType<typeof exportTaskDelivery>> | undefined
  if (result.terminal && result.selectedTaskVersionPath) {
    const spec = (await loadLongTaskSpec(prepared.specPath)).spec
    spec.taskAdaptationContext = await restoreTaskContext(spec, await parse(result.campaignDir, "task-adaptation/task-plan.snapshot.json"))
    const legacy = path.join(dir, "delivery")
    const existing = await lstat(legacy).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return undefined
    })
    if (existing) {
      const previous = await parse(legacy, "delivery.json")
      // 先核验旧交付，不能借新版本绕过旧产物的篡改检查。
      const checked = await exportTaskDelivery(spec, { root: result.campaignDir,
        selectedTaskVersionPath: previous.version, dir: legacy })
      if (path.resolve(previous.version) === path.resolve(result.selectedTaskVersionPath)) delivery = checked
    }
    // 故障后继续择优时保留旧交付，新版本另存而不混写。
    delivery ??= await exportTaskDelivery(spec, { root: result.campaignDir,
      selectedTaskVersionPath: result.selectedTaskVersionPath,
      dir: path.join(dir, "deliveries", fingerprint({ version: result.selectedTaskVersionPath })) })
  }
  // 故障时已有合格版本可保留交付，但故障状态绝不改报成功。
  const outcome = { status: result.status, campaignID: result.campaignID, campaignDir: result.campaignDir,
    terminal: result.terminal, attachedLive: result.attachedLive, taskStopReason: result.taskStopReason,
    selectedTaskVersionPath: result.selectedTaskVersionPath, delivery }
  if (result.terminal) await writeJsonAtomic(path.join(dir, "outcome.json"), outcome)
  return outcome
}
