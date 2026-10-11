import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { loadLongTaskSpec } from "../long-task/spec"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "material.txt"), "Public")
  const entry = { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
    projectManifestPath: path.join(root, "manifest.json"), taskID: "task", phase: "source" }
  const spec = { title: "Fixture", goal: "Learn reusable skill", materials: [{ label: "public", path: "material.txt" }],
    validators: [], protocolPlugins: entry }
  const file = path.join(root, "spec.json")
  return { root, entry, spec, file }
}

test("explicit plugin spec preserves entry and does not synthesize old acceptance mode", async () => {
  const f = await fixture()
  await writeFile(f.file, JSON.stringify(f.spec))
  const loaded = (await loadLongTaskSpec(f.file)).spec
  expect(loaded.protocolPlugins).toEqual(f.entry)
  expect(loaded.campaignFinalAcceptanceMode).toBeUndefined()
  expect(loaded.blankEvalValidatorProfiles).toEqual([])
  await writeFile(f.file, JSON.stringify(loaded))
  expect((await loadLongTaskSpec(f.file)).spec.protocolPlugins).toEqual(f.entry)
})

test("new spec rejects mixed legacy formal execution settings", async () => {
  const f = await fixture()
  for (const extra of [{ campaignFinalAcceptanceMode: "blank_agent" }, { blankEvalExecutor: {} },
    { blankEvalValidatorProfiles: ["old-profile"] }]) {
    await writeFile(f.file, JSON.stringify({ ...f.spec, ...extra }))
    await expect(loadLongTaskSpec(f.file)).rejects.toThrow("cannot mix")
  }
})

test("legacy spec still requires its validators and rejects malformed opt-in", async () => {
  const f = await fixture()
  await writeFile(f.file, JSON.stringify({ ...f.spec, protocolPlugins: undefined }))
  await expect(loadLongTaskSpec(f.file)).rejects.toThrow("validator")
  await writeFile(f.file, JSON.stringify({ ...f.spec, protocolPlugins: { ...f.entry, selectionPath: "relative.json" } }))
  await expect(loadLongTaskSpec(f.file)).rejects.toThrow("absolute")
})
