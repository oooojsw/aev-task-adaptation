import { expect, test } from "bun:test"
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { diagnosisIdentity, claimDiagnosis, completeDiagnosis } from "./diagnosis-reuse"

test("same-stage completed diagnosis reuses only matching inputs and intact result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-diagnosis-"))
  const candidate = path.join(root, "candidate")
  await mkdir(candidate)
  const file = path.join(candidate, "README.md")
  await writeFile(file, "Original")
  const identity = () => diagnosisIdentity({ model: "fixture", round: 1, pass: "pass-01" }, [candidate])
  const dir = path.join(root, "stage")
  const original = await identity()
  expect(await claimDiagnosis(dir, original)).toBe(false)
  await expect(claimDiagnosis(dir, original)).rejects.toThrow("incomplete")
  await writeFile(path.join(dir, "suggestion.json"), "{}")
  await completeDiagnosis(dir, original)
  expect(await claimDiagnosis(dir, await identity())).toBe(true)
  await writeFile(file, "Changed")
  await expect(claimDiagnosis(dir, await identity())).rejects.toThrow("inputs changed")
  await writeFile(file, "Original")
  await writeFile(path.join(dir, "suggestion.json"), "{\"tampered\":true}")
  await expect(claimDiagnosis(dir, await identity())).rejects.toThrow("result fingerprint")
  expect(await diagnosisIdentity({ model: "other" }, [candidate])).not.toBe(original)
})

test("historical diagnosis without identity never silently replays", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aev-diagnosis-old-"))
  await writeFile(path.join(dir, "suggestion.json"), "{}")
  await expect(claimDiagnosis(dir, "fixture")).rejects.toThrow("Historical diagnosis")
})

test("diagnosis identity includes new files, missing inputs, route context and rejects linked trees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-diagnosis-context-"))
  const candidate = path.join(root, "candidate")
  await mkdir(candidate)
  const absent = path.join(root, "feedback.json")
  const original = await diagnosisIdentity({ round: 1, optional: undefined }, [candidate, absent])
  expect(await diagnosisIdentity({ round: 1 }, [absent, candidate, candidate])).toBe(original)
  expect(await diagnosisIdentity({ round: 2 }, [candidate, absent])).not.toBe(original)
  await writeFile(absent, "{}")
  expect(await diagnosisIdentity({ round: 1 }, [candidate, absent])).not.toBe(original)
  const before = await diagnosisIdentity({}, [candidate])
  await writeFile(path.join(candidate, "new.txt"), "New rule")
  expect(await diagnosisIdentity({}, [candidate])).not.toBe(before)
  const linked = path.join(root, "linked")
  await symlink(candidate, linked, process.platform === "win32" ? "junction" : "dir")
  await expect(diagnosisIdentity({}, [linked])).rejects.toThrow("Linked diagnosis")
})
