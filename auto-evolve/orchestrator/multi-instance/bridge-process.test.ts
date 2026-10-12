import { test, expect } from "bun:test"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runBridgeProcess } from "./bridge-process"
import { identifyProcessOwner } from "../process-identity"

test("bridge captures complete output and exit status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-bridge-"))
  const script = path.join(root, "success.js")
  await writeFile(script, 'console.log("complete"); console.error("diagnostic"); process.exitCode=3')
  const result = await runBridgeProcess({ command: [process.execPath, script], cwd: root, timeoutMs: 10000 })
  expect(result.exitCode).toBe(3)
  expect(result.stdout).toContain("complete")
  expect(result.stderr).toContain("diagnostic")
  expect(result.timedOut).toBe(false)
})

test("timeout terminates a real child and grandchild", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-bridge-tree-"))
  const leaf = path.join(root, "leaf.js")
  const script = path.join(root, "parent.js")
  await writeFile(leaf, 'setInterval(()=>{},1000)')
  await writeFile(script, `const {spawn}=require("node:child_process"); const fs=require("node:fs");
const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:"inherit",windowsHide:true});
fs.writeFileSync(${JSON.stringify(path.join(root, "pids.json"))},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`)
  const result = await runBridgeProcess({ command: [process.execPath, script], cwd: root, timeoutMs: 4000 })
  expect(result.timedOut).toBe(true)
  const pids = JSON.parse(await readFile(path.join(root, "pids.json"), "utf8")) as number[]
  for (const pid of pids) expect((await identifyProcessOwner({ pid })).alive).toBe(false)
}, 20000)

test("missing bridge executable rejects rather than hanging", async () => {
  await expect(runBridgeProcess({ command: ["aev-nonexistent-executable-123"], cwd: tmpdir(), timeoutMs: 2000 })).rejects.toThrow()
})
