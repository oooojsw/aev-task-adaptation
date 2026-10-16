import { expect, test } from "bun:test"
import path from "node:path"
import { readFile, mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { TRAINING_ROLES, type TrainingConfig } from "./training"

test("actual Campaign request builder routes worker/lead/reviewer/diagnostician explicitly", async () => {
  const file = path.resolve(import.meta.dir, "../long-task-campaign/runner.ts")
  const source = await readFile(file, "utf8")
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const training: TrainingConfig = { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map((role) =>
    [role, { model: `fixture/${role}`, timeoutMs: 2000 }])) as TrainingConfig["roles"],
    budgets: { maxAttemptsPerUnit: 2, maxTotalUnitAttempts: 8, maxGraphReplans: 1, maxValidatorCalls: 10, maxNoProgressCycles: 2, maxUnitsPerGraph: 5 } }
  const requests: Array<{ model: string; runtimeBudget?: { hardTimeoutMs: number } }> = []
  const holder = globalThis as typeof globalThis & { __trainingRoleInvoke?: (request: unknown) => Promise<unknown>; __trainingRoleConfig?: () => Promise<unknown> }
  holder.__trainingRoleConfig = async () => ({ modelConfig: { defaults: { model: "legacy/default" }, phases: {} } })
  holder.__trainingRoleInvoke = async (request) => { requests.push(request as typeof requests[number]); return { result: { responseText: "{}" } } }
  try {
    // 运行真实请求构建函数；仅替换宿主/模型与证据写入边界。
    const begin = source.indexOf("async function runCampaignSuggestionTask(")
    const end = source.indexOf("\nfunction normalizeWorkerSuggestion(", begin)
    expect(begin).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(begin)
    const rewritten = `
      import { trainingExecution, trainingRuntimeBudget } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "training.ts")).href)};
      import { runProtocolTrainingTask } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "training-invocation.ts")).href)};
      import { taskInvocation } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../task-adaptation/context.ts")).href)};
      import { resolveModelSelection } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../model-selection.ts")).href)};
      const runOpencodeTask = globalThis.__trainingRoleInvoke;
      const loadConfig = globalThis.__trainingRoleConfig;
      const writeTaskArtifacts = async () => ({});
      const verifyTraining = async () => {};
      const uniqueStrings = (values) => [...new Set(values)];
      const extractJsonObject = () => ({});
      export ${source.slice(begin, end)}
    `
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(rewritten)
    const module = await import(`data:text/javascript;base64,${Buffer.from(js + "\n// " + path.basename(root)).toString("base64")}`)
    for (const role of ["worker", "lead", "reviewer", "diagnostician"] as const) {
      await module.runCampaignSuggestionTask({ cwd: root, baseSpec: { id: "task", protocolTraining: training }, title: role,
        prompt: "Fixture", selectionPhase: "solve", trainingRole: role, referencePaths: [], permissionReadPaths: [], stageDir: root, phase: role })
      expect(requests.at(-1)?.model).toBe(`fixture/${role}`)
      expect(requests.at(-1)?.runtimeBudget?.hardTimeoutMs).toBe(2000)
    }
    await module.runCampaignSuggestionTask({ cwd: root, baseSpec: { id: "task" }, title: "Legacy", prompt: "Fixture",
      selectionPhase: "solve", referencePaths: [], permissionReadPaths: [], stageDir: root, phase: "legacy" })
    expect(requests.at(-1)?.model).toBe("legacy/default")
    expect(Object.hasOwn(requests.at(-1)!, "runtimeBudget")).toBe(false)
    await expect(module.runCampaignSuggestionTask({ cwd: root, baseSpec: { id: "task", protocolTraining: training }, title: "Missing role",
      prompt: "Fixture", selectionPhase: "solve", referencePaths: [], permissionReadPaths: [], stageDir: root, phase: "missing" })).rejects.toThrow("training role")
    expect(requests).toHaveLength(5)
  } finally { delete holder.__trainingRoleInvoke; delete holder.__trainingRoleConfig }
})
