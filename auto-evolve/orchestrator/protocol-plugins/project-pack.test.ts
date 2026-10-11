import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { freezePack, loadPack, resumePack, taskFromPack } from "./project-pack"
import type { ProjectPack } from "./project-pack"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(path.join(root, "candidate"), { recursive: true })
  await writeFile(path.join(root, "system.txt"), "Public system")
  await writeFile(path.join(root, "user.txt"), "Public question")
  await writeFile(path.join(root, "gold.json"), '{"answer":false}')
  await writeFile(path.join(root, "candidate", "rules.txt"), "Skill not named README")
  const pack: ProjectPack = { schema: "aev.project-pack.v1", project: { id: "fixture", version: "1",
    skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }, skill: { format: "text",
    entries: [{ id: "skill", kind: "text", path: "rules.txt" }] }, tasks: ["train", "test"].map((split) => ({
      id: `fixture-${split}`, split: split as "train" | "test", materials: [
        { id: "system", kind: "text", path: "system.txt" }, { id: "user", kind: "text", path: "user.txt" }],
      privateInputs: [{ id: "gold", kind: "text", path: "gold.json" }],
    })) }
  const file = path.join(root, "manifest.json")
  await writeFile(file, JSON.stringify(pack))
  return { root, file, pack, candidate: path.join(root, "candidate"), run: path.join(root, "run") }
}

test("project pack binds arbitrary skill entry and actual split", async () => {
  const f = await fixture()
  const value = await loadPack(f.file)
  const task = await taskFromPack(value, "fixture-train", "source", f.candidate)
  expect(task.skill[0].path).toEndWith("rules.txt")
  expect(task.materials.map((item) => item.id)).toEqual(["system", "user"])
  expect(task.privateInputs[0].id).toBe("gold")
  expect(value.artifacts).toHaveLength(3)
})

test("test tasks cannot enter learning or source replay", async () => {
  const f = await fixture()
  const value = await loadPack(f.file)
  await expect(taskFromPack(value, "fixture-test", "source", f.candidate)).rejects.toThrow("split")
  await expect(taskFromPack(value, "fixture-test", "replay", f.candidate)).rejects.toThrow("split")
  await expect(taskFromPack(value, "fixture-train", "test", f.candidate)).rejects.toThrow("split")
  expect((await taskFromPack(value, "fixture-test", "test", f.candidate)).id).toBe("fixture-test")
})

test("project and materials are frozen without copying historical artifacts", async () => {
  const f = await fixture()
  const original = await readFile(f.file, "utf8")
  const value = await loadPack(f.file)
  await freezePack(f.run, value)
  expect(await resumePack(f.run)).toEqual(value)
  expect(await freezePack(f.run, value)).toEqual(value)
  expect(await readFile(f.file, "utf8")).toBe(original)
})

test("source material change blocks resume", async () => {
  const f = await fixture()
  await freezePack(f.run, await loadPack(f.file))
  await writeFile(path.join(f.root, "user.txt"), "changed")
  await expect(resumePack(f.run)).rejects.toThrow("fingerprint drift")
})

test("duplicate UID across splits blocked", async () => {
  const f = await fixture()
  f.pack.tasks[1].id = f.pack.tasks[0].id
  await writeFile(f.file, JSON.stringify(f.pack))
  await expect(loadPack(f.file)).rejects.toThrow("Duplicate task")
})

test("private input cannot also be public material", async () => {
  const f = await fixture()
  f.pack.tasks[0].materials[0].path = "gold.json"
  await writeFile(f.file, JSON.stringify(f.pack))
  await expect(loadPack(f.file)).rejects.toThrow("role collision")
})

test("relative escape and unspecified task blocked", async () => {
  const f = await fixture()
  await expect(taskFromPack(await loadPack(f.file), "unknown", "source", f.candidate)).rejects.toThrow("absent")
  f.pack.skill.entries[0].path = "../gold.json"
  await writeFile(f.file, JSON.stringify(f.pack))
  await expect(loadPack(f.file)).rejects.toThrow("contained")
})
