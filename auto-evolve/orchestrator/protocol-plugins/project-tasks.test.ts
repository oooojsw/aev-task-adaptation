import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile, access } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { prepareProjectTasks } from "./project-tasks"
import { Runtime } from "./runtime"
import { loadLongTaskSpec } from "../long-task/spec"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const pack = path.join(root, "pack")
  await mkdir(pack, { recursive: true })
  await writeFile(path.join(pack, "public.txt"), "Public task")
  await writeFile(path.join(pack, "gold.txt"), "PRIVATE-GOLD")
  const project = { id: "generic", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const phase = { claim: "skill_check", checks: [{ id: "fixture", version: "1", name: "content", required: true,
    target: "skill", stage: "before_execution", mechanism: "script", settings: {} }] }
  const manifestPath = path.join(pack, "manifest.json")
  const selectionPath = path.join(root, "selection.json")
  await writeFile(manifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "custom", kind: "text", path: "custom/rules.txt" }] },
    tasks: ["train", "validation", "test"].map((split) => ({ id: `${split}/arbitrary UID`, split,
      materials: [{ id: "public", kind: "text", path: "public.txt" }],
      privateInputs: [{ id: "gold", kind: "text", path: "gold.txt" }] })) }))
  await writeFile(selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
    protocol: { id: "fixture", version: "1", phases: { source: phase, test: phase } } }))
  const runtime = new Runtime().addChecker({ id: "fixture", version: "1", implementation: "a".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => { throw new Error("Must not execute") })
  return { root, runtime, input: { manifestPath, selectionPath, destination: path.join(root, "tasks-output"),
    trainingGoal: "Learn reusable rules using public materials" } }
}

test("generic project preparation retains splits and arbitrary IDs without exposing private inputs", async () => {
  const f = await fixture()
  const output = await prepareProjectTasks(f.input, f.runtime)
  expect(output.tasks.map((row) => row.role)).toEqual(["train", "test"])
  expect(output.excludedValidationUIDs).toEqual(["validation/arbitrary UID"])
  for (const row of output.tasks) {
    const data = await readFile(row.specPath, "utf8")
    expect(data).not.toContain("gold.txt")
    expect(data).not.toContain("PRIVATE-GOLD")
    const spec = (await loadLongTaskSpec(row.specPath)).spec
    expect(spec.protocolPlugins!.taskID).toBe(row.id)
    expect(spec.protocolPlugins!.phase).toBe(row.role === "test" ? "test" : "source")
    expect(spec.materials).toHaveLength(1)
  }
  await expect(prepareProjectTasks(f.input, f.runtime)).rejects.toThrow()
})

test("generic project mismatch or unsafe destination blocks without output", async () => {
  const f = await fixture()
  const selection = JSON.parse(await readFile(f.input.selectionPath, "utf8"))
  selection.project.id = "different"
  await writeFile(f.input.selectionPath, JSON.stringify(selection))
  await expect(prepareProjectTasks(f.input, f.runtime)).rejects.toThrow("mismatch")
  await expect(access(f.input.destination)).rejects.toThrow()
  selection.project.id = "generic"
  await writeFile(f.input.selectionPath, JSON.stringify(selection))
  await expect(prepareProjectTasks({ ...f.input, destination: path.join(f.root, "pack", "output") }, f.runtime)).rejects.toThrow("outside")
})
