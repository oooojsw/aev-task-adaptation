import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { buildNbaPack } from "../../projects/nba/pack"
import { builtins } from "./builtins"
import { runEntry, type Entry } from "./entry"

test("NBA pack runs real HTTP/script protocol and scorer switch reuses original answer", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const source = path.join(root, "original")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ split: { train: ["source-1"], test: ["test-1"] } }))
  for (const [split, id] of [["train", "source-1"], ["test", "test-1"]]) {
    for (const role of ["public", "private-answers"]) await mkdir(path.join(source, role, split), { recursive: true })
    await writeFile(path.join(source, "public", split, id + ".json"), JSON.stringify({ system_prompt: "NBA public rules",
      user_prompt: "Decide public operation " + id, hidden_metadata: "PRIVATE_METADATA_MARKER" }))
    await writeFile(path.join(source, "private-answers", split, id + ".json"), JSON.stringify({ answer: false,
      private_note: "PRIVATE_GOLD_MARKER" }))
  }
  const manifest = await buildNbaPack(source, path.join(root, "pack"))
  const candidate = path.join(root, "candidate")
  await mkdir(candidate)
  await writeFile(path.join(candidate, "skill.txt"), "Reusable legality procedure")
  const requests: Array<Record<string, any>> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions")
    const body = await request.json() as Record<string, any>
    requests.push(body)
    expect(body.tools).toBeUndefined()
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].content).toBe('NBA public rules\n\nSkill file "skill":\nReusable legality procedure')
    expect(body.messages[1].content).toContain("Decide public operation")
    expect(JSON.stringify(body)).not.toContain("PRIVATE_GOLD_MARKER")
    expect(JSON.stringify(body)).not.toContain("PRIVATE_METADATA_MARKER")
    return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { content: "answer: false" } }],
      usage: { prompt_tokens: 30, completion_tokens: 3 } })
  } })
  const credentialEnv = "AEV_NBA_OFFLINE_FIXTURE_" + randomUUID().replaceAll("-", "").toUpperCase()
  process.env[credentialEnv] = "synthetic-fixture-not-a-real-key"
  try {
    const runtime = await builtins(path.join(root, "backends"))
    const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
    const python = "C:/Users/ZhuanZ/miniconda3/python.exe"
    const executor = { id: "http-text-chat", version: "1", settings: { dialect: "openai_chat",
      url: server.url.origin + "/v1/chat/completions", allowedOrigins: [server.url.origin],
      model: "fixture-nba", expectedModel: "fixture-nba", credentialEnv, systemInput: "system", userInputs: ["user"],
      skillPlacement: "system", maxTokens: 100, maxInputBytes: 10000, maxResponseBytes: 4096, temperature: 0, timeoutMs: 1000 } }
    async function entry(name: string, scorerName: string, taskID = "source-1", phase: "source" | "test" = "source") {
      const script = path.resolve(import.meta.dir, "../../projects/nba", scorerName)
      const plan = { claim: "task_execution", executor, checks: [{ id: "script-json-checker", version: "1",
        name: "nba-product", target: "product", stage: "after_execution", mechanism: "script", required: true, privateInputs: ["gold"],
        settings: { command: python, commandSHA256: await hash(python), script, scriptSHA256: await hash(script),
          timeoutMs: 10000, maxOutputBytes: 4096 } }] }
      const selectionPath = path.join(root, name + ".json")
      await writeFile(selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1", project: manifest.pack.project,
        run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
        protocol: { id: "nba-offline", version: "1", phases: { source: plan, test: plan } } }))
      return { schema: "aev.protocol-entry.v1", selectionPath, projectManifestPath: path.join(root, "pack/manifest.json"), taskID, phase } as Entry
    }
    const local = await entry("local", "scorer.py")
    const first = await runEntry(path.join(root, "local-run"), local, candidate, path.join(root, "local-attempt"), runtime)
    expect(first.status).toBe("passed")
    expect(first.claim).toBe("task_execution")
    expect(first.executionReused).toBe(false)
    const official = await entry("official", "official-scorer.py")
    const rescored = await runEntry(path.join(root, "official-run"), official, candidate, path.join(root, "official-attempt"), runtime)
    expect(rescored.status).toBe("rejected")
    expect(rescored.executionReused).toBe(true)
    expect(rescored.usage).toEqual(first.usage)
    expect(requests).toHaveLength(1)
    const missingGold = await entry("missing-gold", "scorer.py")
    const missingSelection = JSON.parse(await readFile(missingGold.selectionPath, "utf8"))
    missingSelection.protocol.phases.source.checks[0].privateInputs = []
    await writeFile(missingGold.selectionPath, JSON.stringify(missingSelection))
    const missing = await runEntry(path.join(root, "missing-run"), missingGold, candidate, path.join(root, "missing-attempt"), runtime)
    expect(missing.status).toBe("data_error")
    expect(missing.executionReused).toBe(true)
    expect(requests).toHaveLength(1)
    const heldout = await entry("heldout", "scorer.py", "test-1", "test")
    const testReceipt = await runEntry(path.join(root, "test-run"), heldout, candidate, path.join(root, "test-attempt"), runtime)
    expect(testReceipt.status).toBe("passed")
    expect(requests).toHaveLength(2)
    expect(requests[1].messages[1].content).toBe("Decide public operation test-1")
  } finally {
    delete process.env[credentialEnv]
    server.stop(true)
  }
})
