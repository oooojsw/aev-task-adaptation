import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { main } from "../../scripts/report-task-usage"
import { reserveRequest, settleRequest } from "./request-budget"

test("usage CLI reports existing wallet and preserves original evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-usage-cli-"))
  const config = { root, scope: "fixture", calls: 10, tokens: 1000 }
  const file = path.join(root, "config.json")
  await writeFile(file, "\uFEFF" + JSON.stringify(config))
  await reserveRequest(config, { id: "one", role: "lead", model: "fixture/model", request: "a".repeat(64), reservationTokens: 100 })
  await settleRequest(config, "one", 30, { inputTokens: 20, outputTokens: 10, dialect: "openai_chat", outcome: "complete" })
  const before = await readFile(path.join(root, "budget.json"), "utf8")
  const saved = console.log, printed: string[] = []
  try {
    console.log = value => { printed.push(String(value)) }
    await main(["--budget", file])
  } finally { console.log = saved }
  const result = JSON.parse(printed[0])
  expect(result.admittedAttempts).toBe(1)
  expect(result.reportedTokens).toBe(30)
  expect(result.groups[0].role).toBe("lead")
  expect(result.attempts[0].usage.inputTokens).toBe(20)
  expect(await readFile(path.join(root, "budget.json"), "utf8")).toBe(before)
})

test("usage CLI rejects missing wallet and wrong identity without creating a wallet", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-usage-cli-missing-"))
  const file = path.join(root, "config.json")
  await writeFile(file, JSON.stringify({ root, scope: "fixture", calls: 10, tokens: 1000 }))
  await expect(main(["--budget", file])).rejects.toThrow()
  expect(await readdir(root)).toEqual(["config.json"])
  await writeFile(file, JSON.stringify({ root, scope: "fixture", calls: 10, tokens: 1000, key: "not-allowed" }))
  await expect(main(["--budget", file])).rejects.toThrow("Original request budget identity required")
  await expect(main(["--budget", "relative.json"])).rejects.toThrow("Expected --budget")
})
