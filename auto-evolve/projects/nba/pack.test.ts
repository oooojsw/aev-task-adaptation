import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile, access } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { buildNbaPack } from "./pack"

async function fixture() {
  const base = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const source = path.join(base, "source")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ split: { train: ["task-a"], test: ["task-b"] } }))
  for (const [split, id] of [["train", "task-a"], ["test", "task-b"]]) {
    for (const role of ["public", "private-answers"]) await mkdir(path.join(source, role, split), { recursive: true })
    await writeFile(path.join(source, "public", split, `${id}.json`), JSON.stringify({ system_prompt: "Rules", user_prompt: "Question", secret_metadata: "DO NOT EXPORT" }))
    await writeFile(path.join(source, "private-answers", split, `${id}.json`), '{"answer":false}')
  }
  return { source, target: path.join(base, "pack") }
}

test("NBA adapter exports public fields and separate scorer inputs without modifying source", async () => {
  const f = await fixture()
  const original = await readFile(path.join(f.source, "manifest.json"), "utf8")
  const snapshot = await buildNbaPack(f.source, f.target)
  expect(snapshot.pack.tasks).toHaveLength(2)
  expect(await readFile(path.join(f.target, "tasks/train/task-a/system.txt"), "utf8")).toBe("Rules")
  expect(await readFile(path.join(f.target, "tasks/train/task-a/user.txt"), "utf8")).toBe("Question")
  expect(await readFile(path.join(f.source, "manifest.json"), "utf8")).toBe(original)
  await access(path.join(f.target, "complete.json"))
  await expect(buildNbaPack(f.source, f.target)).rejects.toThrow()
})

test("NBA malformed prompts fail before creating destination", async () => {
  const f = await fixture()
  await writeFile(path.join(f.source, "public/train/task-a.json"), '{}')
  await expect(buildNbaPack(f.source, f.target)).rejects.toThrow("Missing public")
  await expect(access(f.target)).rejects.toThrow()
})

test("NBA overlapping splits and destination inside source are rejected", async () => {
  const f = await fixture()
  await expect(buildNbaPack(f.source, path.join(f.source, "pack"))).rejects.toThrow("outside")
  await writeFile(path.join(f.source, "manifest.json"), JSON.stringify({ split: { train: ["task-a"], test: ["task-a"] } }))
  await expect(buildNbaPack(f.source, f.target)).rejects.toThrow("overlapping")
  await expect(access(f.target)).rejects.toThrow()
})
