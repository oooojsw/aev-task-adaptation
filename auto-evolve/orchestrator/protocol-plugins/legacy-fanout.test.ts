import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import type { CoordinatorState } from "../multi-instance/contract"

for (const mode of ["passed", "exhausted", "crash"]) test(`legacy fanout ${mode} matches original Git checkpoint`, async () => {
  const original = Bun.spawnSync(["git", "show", "7d8b7d3:auto-evolve/orchestrator/multi-instance/coordinator.ts"], { cwd: import.meta.dir })
  expect(original.exitCode).toBe(0)
  const file = path.resolve(import.meta.dir, "../multi-instance/coordinator.ts")
  const observations = []
  for (const source of [original.stdout.toString(), await readFile(file, "utf8")]) {
    const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
    const task = path.join(root, "task")
    const campaign = path.join(root, "campaign")
    const pending = path.join(campaign, "pending-expert-package", "current")
    await mkdir(pending, { recursive: true })
    await mkdir(task)
    await writeFile(path.join(pending, "README.md"), "Fixed original Skill")
    const requests: unknown[] = []
    const holder = globalThis as typeof globalThis & { __legacyFanout?: (input: unknown) => Promise<unknown> }
    holder.__legacyFanout = async (input) => {
      requests.push(input)
      if (mode === "crash") throw new Error("Fixed infrastructure failure")
      return { mode: "campaign", runDir: campaign, runRoot: campaign, passed: mode === "passed" }
    }
    try {
      // 两版各跑真实调度与收集；只替换会调用模型的任务边界。
      const rewritten = source.replace('import { runSkillsBenchTask } from "../skillsbench-adapter"', "const runSkillsBenchTask = globalThis.__legacyFanout")
        .replace(/from\s+"(\.[^"]+)"/g, (_, name: string) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(file), name + ".ts")).href)}`)
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(rewritten)
      const module = await import(`data:text/javascript;base64,${Buffer.from(js + "\n// " + path.basename(root)).toString("base64")}`)
      const state: CoordinatorState = { id: "legacy", label: "Legacy", phase: "phase1_fanout", createdAt: "fixed", updatedAt: "fixed",
        runRoot: path.join(root, "coordinator"), options: { skillsbenchRoot: root, rounds: 1, fanoutLimit: 1 }, log: [],
        instances: [
          { id: "task", sourceTaskRoot: task, engine: "skillsbench", role: "train", status: "queued", rounds: 1 },
          { id: "heldout", sourceTaskRoot: task, engine: "skillsbench", role: "test", status: "queued", rounds: 1 } ] }
      const outcome = await module.runCoordinatorPhase1Fanout({ cwd: root, state })
      expect(requests).toHaveLength(1)
      const harvested = state.instances[0].harvestedSkillPath
      const skill = harvested ? await readFile(path.join(harvested, "README.md"), "utf8") : undefined
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => {
        if (["durationMs", "createdAt", "updatedAt", "finishedAt", "heartbeatAt", "at"].includes(key)) return undefined
        return typeof item === "string" ? item.replaceAll(root, "<ROOT>").replaceAll(root.replaceAll("\\", "/"), "<ROOT>")
          .replaceAll(`skillsbench:${path.basename(root)}`, "skillsbench:<ROOT-SLOT>") : item
      }))
      observations.push(normalize({ requests, outcome, state, skill }))
    } finally { delete holder.__legacyFanout }
  }
  expect(observations[1]).toEqual(observations[0])
})
