import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { builtins } from "../protocol-plugins/builtins"
import { preflightBindings } from "./preflight-bindings"
import type { Binding } from "../protocol-plugins/contract"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-binding-preflight-"))
  const command = path.join(root, "interpreter.bin")
  const script = path.join(root, "checker.py")
  await writeFile(command, "dependency fixture never executed")
  await writeFile(script, "checker fixture never executed")
  const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
  const runtime = await builtins(path.join(root, "backend"))
  const binding: Binding = { id: "script-json-checker", version: "1", settings: {
    command, commandSHA256: await hash(command), script, scriptSHA256: await hash(script), timeoutMs: 1000, maxOutputBytes: 1000 } }
  return { root, script, runtime, binding }
}

test("dependency hashes are checked without executing scorer or model", async () => {
  const f = await fixture()
  expect(await preflightBindings({ checkers: [{ name: "check", binding: f.binding }] }, f.runtime.registry))
    .toEqual([{ id: "script-json-checker", version: "1", checks: ["registered_plugin", "settings_valid", "local_dependency_hashes"] }])
  await writeFile(f.script, "changed checker")
  await expect(preflightBindings({ checkers: [{ name: "check", binding: f.binding }] }, f.runtime.registry)).rejects.toThrow("fingerprint")
})

test("missing credential reference blocks locally without testing or disclosing the secret", async () => {
  const f = await fixture()
  const binding: Binding = { id: "http-text-chat", version: "1", settings: { dialect: "openai_chat",
    url: "http://127.0.0.1:1/chat", allowedOrigins: ["http://127.0.0.1:1"], model: "fixture", expectedModel: "fixture",
    credentialEnv: "AEV_PREFLIGHT_SYNTHETIC", systemInput: "system", userInputs: ["user"], skillPlacement: "system",
    maxTokens: 100, maxInputBytes: 1000, maxResponseBytes: 1000, temperature: 0, timeoutMs: 1000 } }
  await expect(preflightBindings({ executor: binding, checkers: [] }, f.runtime.registry, () => undefined)).rejects.toThrow("credential reference")
  const evidence = await preflightBindings({ executor: binding, checkers: [] }, f.runtime.registry, () => "synthetic-never-sent")
  expect(evidence[0].checks).toContain("credential_reference_present")
  expect(JSON.stringify(evidence)).not.toContain("synthetic-never-sent")
})
