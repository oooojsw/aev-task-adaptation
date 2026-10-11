import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import type { CoordinatorState } from "../multi-instance/contract"

for (const mode of ["partial", "complete", "gate-pass", "gate-fail"]) test(`legacy merger ${mode} matches baseline behavior`, async () => {
  const complete = mode !== "partial"
  const gate = mode.startsWith("gate-")
  const baseline = Bun.spawnSync(["git", "show", "7d8b7d3:auto-evolve/orchestrator/multi-instance/merger.ts"], { cwd: import.meta.dir })
  expect(baseline.exitCode).toBe(0)
  const file = path.resolve(import.meta.dir, "../multi-instance/merger.ts")
  const observations = []
  for (const source of [baseline.stdout.toString(), await readFile(file, "utf8")]) {
    const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
    const task = path.join(root, "task")
    const skill = path.join(root, "source-skill")
    await mkdir(task, { recursive: true })
    await mkdir(skill)
    await writeFile(path.join(skill, "README.md"), "Reusable legacy guidance")
    await writeFile(path.join(task, "public.txt"), "Public task")
    await writeFile(path.join(task, "check.py"), "# Never executed in fixture\n")
    await writeFile(path.join(task, "spec.json"), JSON.stringify({ id: "task", title: "Legacy task", goal: "Produce answer",
      materials: [{ path: "public.txt", label: "public" }], validators: [{ id: "product", title: "Product",
        type: "script", path: "check.py", placement: "completion_only",
        ...(gate ? { validation: { target: "surface", stage: "post_merge" } } : {}) }] }))
    const prompt = path.join(root, "merge-prompt.md")
    await writeFile(prompt, "Merge reusable guidance according to the contract.")
    const requests: unknown[] = []
    const checks: unknown[] = []
    const holder = globalThis as typeof globalThis & {
      __aevLegacyMerge?: (input: { permissionEditPaths: string[] }) => Promise<unknown>
      __aevLegacyConfig?: () => Promise<Record<string, unknown>>
      __aevLegacyStage?: (input: { stageDir: string }) => Promise<unknown>
    }
    holder.__aevLegacyConfig = async () => ({})
    holder.__aevLegacyStage = async (input) => {
      checks.push(input)
      return { passed: mode !== "gate-fail", summary: "Fixed gate verdict", resultPath: path.join(input.stageDir, "result.json") }
    }
    holder.__aevLegacyMerge = async (input) => {
      requests.push(input)
      const output = input.permissionEditPaths[0]
      for (const name of complete ? ["INDEX.md", "CORE.md", "meta.json"] : ["INDEX.md"]) {
        await writeFile(path.join(output, name), "Fixed legacy output")
      }
      return { result: { stdout: "Fixed stdout", stderr: "", responseText: "Fixed response" } }
    }
    try {
      // 只固定模型与配置边界，仍执行两版自身的完整合并控制代码。
      const rewritten = source.replace('import { runOpencodeTask } from "../opencode"', "const runOpencodeTask = globalThis.__aevLegacyMerge")
        .replace('import { loadConfig } from "../schema"', "const loadConfig = globalThis.__aevLegacyConfig")
        .replace('import { runValidationStage } from "../validation-engine/stage-runner"', "const runValidationStage = globalThis.__aevLegacyStage")
        .replace(/from\s+"(\.[^"]+)"/g, (_, name: string) =>
          `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), name + ".ts")).href)}`)
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(rewritten)
      const module = await import(`data:text/javascript;base64,${Buffer.from(js + "\n// " + path.basename(root)).toString("base64")}`)
      const state: CoordinatorState = { id: "legacy", label: "Legacy", phase: "phase1_fanout", createdAt: "fixed", updatedAt: "fixed",
        runRoot: path.join(root, "coordinator"), options: { skillsbenchRoot: root, rounds: 1, fanoutLimit: 1 }, log: [],
        instances: [{ id: "task", engine: "skillsbench", sourceTaskRoot: task, role: "train", status: "passed", rounds: 1,
          harvestedSkillPath: skill }] }
      let outcome
      let error
      try { outcome = await module.runCoordinatorPhase2Merge({ cwd: root, state, promptPath: prompt }) }
      catch (cause) { error = String(cause) }
      expect(requests).toHaveLength(1)
      expect(checks).toHaveLength(gate ? 1 : 0)
      expect(Boolean(error)).toBe(mode === "gate-fail")
      const output = await readdir(state.mergedSkillDir!)
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => {
        if (["durationMs", "createdAt", "updatedAt", "heartbeatAt", "at"].includes(key)) return undefined
        return typeof item === "string" ? item.replaceAll(root, "<ROOT>").replaceAll(root.replaceAll("\\", "/"), "<ROOT>") : item
      }))
      observations.push(normalize({ requests, checks, outcome, error, state, output: output.sort() }))
    } finally {
      delete holder.__aevLegacyMerge
      delete holder.__aevLegacyConfig
      delete holder.__aevLegacyStage
    }
  }
  expect(observations[1]).toEqual(observations[0])
})
