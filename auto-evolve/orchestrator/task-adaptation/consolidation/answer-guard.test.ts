import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { answerLeak, guardRows } from "./answer-guard"
import { digest, publication } from "./contract"
import { consolidationPlugins } from "../../protocol-plugins/consolidation"

const rows = [{ caseID: "UID0001", question: "What is the documented total for the named category in the official source?", answer: "731942" }]
for (const text of ["UID0001: 731942", 'answer["UID0001"] = "731942"', '| UID0001 | 731942 |',
  '"UID0001":731942', "ＵＩＤ０００１：７３１９４２", `${rows[0].question} Answer: 731942`,
  ...["base64", "hex"].flatMap(encoding => ["UID0001:731942", JSON.stringify({ UID0001: "731942" }),
    `${rows[0].question} Answer: 731942`, 'lookup["UID0001"]="731942"', "UID0001 => 731942"]
    .map(value => Buffer.from(value).toString(encoding as BufferEncoding)))]) {
  test(`answer guard rejects mapping ${text.slice(0, 32)}`, () => expect(answerLeak(text, rows)).toBeDefined())
}
for (const text of ["Sum all applicable rows.", "Divide by 100 for percent.", "Use 731942 as an illustrative example.",
  "Do not carry numeric task answers into the Skill.", "Read source tables before computing.",
  "Respect units and dates.", "Return only the final value.", "Prefer explicit evidence to memory.",
  "Check rounding and denominator.", "For UID0001 use general arithmetic, not memorized results.",
  "A total might be 731942.", "Use 2000 and 2001 as years.", "The answer depends on source.",
  "This document mentions the source question but provides no cached answer.", "Encode document identifiers if required."]) {
  test(`answer guard allows general or ambiguous rule ${text}`, () => expect(answerLeak(text, rows)).toBeUndefined())
}
test("guard freezes manifest and rejects drift, rejects before executor; legacy settings remain usable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-answer-guard-"))
  const file = path.join(root, "private.json")
  await writeFile(file, JSON.stringify(rows))
  const answerGuard = { path: file, sha256: digest(await readFile(file)) }
  expect(await guardRows(answerGuard, 1)).toEqual(rows)
  const plugin = await consolidationPlugins(path.join(root, "plugin"))
  const settings = { candidateID: "merged_skill", maxChars: 4999, expectedCases: 1, modelID: "consumer", datasetSHA256: "a".repeat(64), answerGuard }
  const run = async (text: string, guarded = true) => {
    const bytes = Buffer.from(text)
    const legacy = { ...settings } as Record<string, unknown>
    if (!guarded) delete legacy.answerGuard
    return plugin.evaluate({ task: "merge", phase: "source", settings: legacy,
      skill: [{ id: "merged_skill", kind: "text", bytes, sha256: digest(bytes), length: bytes.length }],
      materials: [], privateInputs: [], candidate: [], check: { name: "surface", stage: "before_execution", target: "skill", mechanism: "script" } })
  }
  expect((await run("UID0001: 731942")).status).toBe("rejected")
  expect((await run("x".repeat(4999))).status).toBe("passed")
  expect((await run("x".repeat(5000))).status).toBe("rejected")
  expect(publication(Buffer.from("x".repeat(4999)), 4999).chars).toBe(4999)
  expect((await run("UID0001: 731942", false)).status).toBe("passed")
  await writeFile(file, "[]")
  expect((await run("Use source evidence.")).status).toBe("scoring_error")
})
