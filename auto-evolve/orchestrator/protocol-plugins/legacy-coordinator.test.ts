import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import type { CoordinatorState } from "../multi-instance/contract"

for (const passed of [false, true]) test(`legacy replay ${passed ? "acceptance" : "rejection"} matches pre-upgrade Git checkpoint`, async () => {
  const result = Bun.spawnSync(["git", "show", "7d8b7d3:auto-evolve/orchestrator/multi-instance/validator.ts"], { cwd: import.meta.dir })
  expect(result.exitCode).toBe(0)
  const currentFile = path.resolve(import.meta.dir, "../multi-instance/validator.ts")
  const sources = [result.stdout.toString(), await readFile(currentFile, "utf8")]
  const observations = []
  for (const source of sources) {
    const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
    const taskRoot = path.join(root, "task")
    const candidate = path.join(root, "merged")
    await mkdir(taskRoot, { recursive: true })
    await mkdir(candidate)
    await writeFile(path.join(candidate, "README.md"), "Legacy reusable Skill")
    await writeFile(path.join(taskRoot, "public.txt"), "Public task")
    await writeFile(path.join(taskRoot, "spec.json"), JSON.stringify({ id: "legacy-task", title: "Legacy", goal: "Produce answer",
      materials: [{ path: "public.txt", label: "public" }], targetPaths: [{ path: "workspace/result.txt", label: "answer" }],
      editablePaths: ["workspace"], validators: [{ id: "product-check", title: "Product check", type: "script", path: "check.py", args: [], placement: "completion_only" }] }))
    await writeFile(path.join(taskRoot, "check.py"), "# Fixed test validator, never executed\n")
    const requests: unknown[] = []
    const specs: unknown[] = []
    const holder = globalThis as typeof globalThis & { __aevLegacyReplay?: (input: any) => Promise<any> }
    holder.__aevLegacyReplay = async (input) => {
      requests.push(input)
      specs.push(JSON.parse(await readFile(input.specPath, "utf8")))
      return { passed, runDir: input.runRoot, summary: passed ? "Fixed acceptance" : "Fixed ordinary rejection" }
    }
    try {
      // 只替换外部执行边界，两版都运行自身的真实调度与配置生成代码。
      const rewritten = source.replace('import { runBlankEval } from "../blank-eval/runner"',
        'const runBlankEval = globalThis.__aevLegacyReplay')
        .replace(/from\s+"(\.[^"]+)"/g, (_, name: string) =>
          `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(currentFile), name + ".ts")).href)}`)
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(rewritten)
      // 隔离模块缓存，避免下一夹具仍调用上一夹具的执行回执。
      const module = await import(`data:text/javascript;base64,${Buffer.from(js + "\n// " + path.basename(root)).toString("base64")}`)
      const state: CoordinatorState = { id: "legacy", label: "Legacy", phase: "phase2_merge", createdAt: "fixed", updatedAt: "fixed",
        runRoot: path.join(root, "coordinator"), mergedSkillDir: candidate, options: { skillsbenchRoot: root, rounds: 1, fanoutLimit: 1 }, log: [],
        instances: [{ id: "legacy-task", engine: "skillsbench", sourceTaskRoot: taskRoot, role: "train", status: "passed", rounds: 1 }] }
      const outcome = await module.runCoordinatorPhase3Validate({ cwd: root, state })
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => {
        if (["durationMs", "createdAt", "updatedAt", "heartbeatAt", "at"].includes(key)) return undefined
        if (typeof item === "string") return item.replaceAll(root, "<ROOT>").replaceAll(root.replaceAll("\\", "/"), "<ROOT>")
        return item
      }))
      observations.push(normalize({ requests, specs, outcome, state }))
      expect(requests).toHaveLength(1)
    } finally { delete holder.__aevLegacyReplay }
  }
  expect(observations[1]).toEqual(observations[0])
})
