import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile, readFile, access } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { recoverBatchLease } from "./batch-recovery"
import type { identifyProcessOwner, ProcessIdentityResult } from "../process-identity"

async function fixture() {
  const runRoot = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(runRoot, { recursive: true })
  const lease = { nonce: randomUUID(), pid: 1234, startedAt: new Date().toISOString(), ownerCreationTick: "100" }
  const file = path.join(runRoot, "project-batch.invocation.claim")
  await writeFile(file, JSON.stringify(lease))
  return { runRoot, lease, file, input: { runRoot, expectedNonce: lease.nonce } }
}

const owner = (result: ProcessIdentityResult) => (async () => result) as typeof identifyProcessOwner

test("explicit stopped batch lease recovery preserves original and starts no calls", async () => {
  for (const result of [{ alive: false, ownership: "dead", reason: "fixture stopped" },
    { alive: true, ownership: "wrong_owner", creationTick: "200", reason: "fixture reused PID" }] as ProcessIdentityResult[]) {
    const f = await fixture()
    const original = await readFile(f.file)
    const recovered = await recoverBatchLease(f.input, owner(result))
    expect(recovered.callsStarted).toBe(0)
    expect(await readFile(path.join(recovered.recoveryRoot, "original-lease.json"))).toEqual(original)
    await expect(access(f.file)).rejects.toThrow()
  }
})

test("active unknown and weak mismatched owners cannot be unlocked", async () => {
  for (const result of [{ alive: true, ownership: "owned", creationTick: "100", reason: "active" },
    { alive: true, ownership: "unknown_owner", reason: "unreadable" },
    { alive: true, ownership: "wrong_owner", reason: "weak hint mismatch" }] as ProcessIdentityResult[]) {
    const f = await fixture()
    const original = await readFile(f.file)
    await expect(recoverBatchLease(f.input, owner(result))).rejects.toThrow("live or unverified")
    expect(await readFile(f.file)).toEqual(original)
  }
})

test("changed nonce or lease during stopped owner inspection blocks archive", async () => {
  const f = await fixture()
  await expect(recoverBatchLease({ ...f.input, expectedNonce: "other" }, owner({ alive: false, ownership: "dead", reason: "stopped" })))
    .rejects.toThrow("identity mismatch")
  let checks = 0
  const identify = async () => {
    checks++
    if (checks === 2) await writeFile(f.file, JSON.stringify({ ...f.lease, nonce: "changed" }))
    return { alive: false, ownership: "dead" as const, reason: "stopped" }
  }
  await expect(recoverBatchLease(f.input, identify)).rejects.toThrow("changed during recovery")
  expect(JSON.parse(await readFile(f.file, "utf8")).nonce).toBe("changed")
})

test("actual CLI archives dead owner but refuses live process without deleting its lease", async () => {
  const cli = path.resolve(import.meta.dir, "../../cli.ts")
  for (const live of [false, true]) {
    const f = await fixture()
    await writeFile(f.file, JSON.stringify({ nonce: f.lease.nonce, pid: live ? process.pid : 2147483647,
      startedAt: f.lease.startedAt }))
    const original = await readFile(f.file)
    const child = Bun.spawn([process.execPath, cli, "recover-protocol-batch-lease", "--out", f.runRoot,
      "--expected-nonce", f.lease.nonce], { cwd: f.runRoot, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (live) {
      expect(code).not.toBe(0)
      expect(stderr).toContain("live or unverified")
      expect(await readFile(f.file)).toEqual(original)
    } else {
      expect(code).toBe(0)
      expect(stdout).toContain("no model calls started")
      await expect(access(f.file)).rejects.toThrow()
    }
  }
}, 20000)
