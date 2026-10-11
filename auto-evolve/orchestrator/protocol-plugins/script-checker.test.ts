import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { scriptChecker } from "./script-checker"
import type { Artifact, Evaluate } from "./runtime"

const python = "C:/Users/ZhuanZ/miniconda3/python.exe"
const scorer = fileURLToPath(new URL("../../projects/nba/scorer.py", import.meta.url))
const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
function artifact(id: string, text: string): Artifact {
  return { id, kind: "text", bytes: Buffer.from(text), length: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex") }
}
async function root() {
  const dir = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(dir, { recursive: true })
  return dir
}
async function input(answer: string, gold: object): Promise<Parameters<Evaluate>[0]> {
  return { task: "fixture", phase: "source", skill: [], materials: [],
    candidate: [artifact("answer", answer)], privateInputs: [artifact("gold", JSON.stringify(gold))],
    check: { name: "nba-product", target: "product", stage: "after_execution", mechanism: "script" },
    settings: { command: python, commandSHA256: await hash(python), script: scorer, scriptSHA256: await hash(scorer),
      timeoutMs: 10000, maxOutputBytes: 4096 } }
}

test("NBA real Python scorer accepts legal answer and rejects illegal conclusion", async () => {
  const plugin = await scriptChecker(await root())
  const legal = { answer: false }
  expect((await plugin.evaluate(await input("Answer: False", legal))).status).toBe("passed")
  expect((await plugin.evaluate(await input("Answer: True. Illegal Operation: A. Problematic Team: B", legal))).status).toBe("rejected")
})

test("NBA scorer checks operation/team, formatting and last conclusion", async () => {
  const plugin = await scriptChecker(await root())
  const gold = { answer: true, illegal_operation: "A", problematic_team: "B" }
  for (const [answer, expected] of [
    ["**Answer: True. Illegal Operation: A. Problematic Team: B**", "passed"],
    ["Answer: True. Illegal Operation: C. Problematic Team: B", "rejected"],
    ["Answer: True", "rejected"],
    ["Answer: False\nFinal: Answer: True. Illegal Operation: A. Problematic Team: B", "passed"],
    ["Answer: True. Illegal Operation: A. Problematic Team: B\nAnswer: False", "rejected"],
  ]) expect((await plugin.evaluate(await input(answer, gold))).status).toBe(expected)
})

test("NBA label schema problem is data error, not ordinary rejection", async () => {
  const plugin = await scriptChecker(await root())
  expect((await plugin.evaluate(await input("Answer: False", { answer: "false" }))).status).toBe("data_error")
})

test("interpreter/scorer fingerprint drift blocks invocation", async () => {
  const plugin = await scriptChecker(await root())
  const value = await input("Answer: False", { answer: false })
  value.settings.scriptSHA256 = "0".repeat(64)
  expect((await plugin.evaluate(value)).status).toBe("scoring_error")
})

test("scorer crash or non-JSON output cannot pass", async () => {
  const dir = await root()
  const script = path.join(dir, "broken.py")
  await writeFile(script, 'print("not a JSON verdict")\n')
  const plugin = await scriptChecker(dir)
  const value = await input("Answer: False", { answer: false })
  Object.assign(value.settings, { script, scriptSHA256: await hash(script) })
  expect((await plugin.evaluate(value)).status).toBe("scoring_error")
})

test("timeout and oversized output are scoring infrastructure failures", async () => {
  for (const body of ['import time\ntime.sleep(2)\n', 'print("x" * 10000)\n']) {
    const dir = await root()
    const script = path.join(dir, "bounded.py")
    await writeFile(script, body)
    const plugin = await scriptChecker(dir)
    const value = await input("Answer: False", { answer: false })
    Object.assign(value.settings, { script, scriptSHA256: await hash(script), timeoutMs: 100, maxOutputBytes: 1024 })
    expect((await plugin.evaluate(value)).status).toBe("scoring_error")
  }
})
