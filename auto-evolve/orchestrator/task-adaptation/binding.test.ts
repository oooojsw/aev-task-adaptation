import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, link } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bindPlan, boundWindow, verifyBinding, freezePlan } from "./binding"
import type { Plan } from "./plan"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-task-binding-"))
  await mkdir(path.join(root, "private"))
  await writeFile(path.join(root, "report.md"), "candidate")
  await writeFile(path.join(root, "source.txt"), "public evidence")
  await writeFile(path.join(root, "private/rubric.txt"), "private grading")
  const plan: Plan = {
    schema: "aev.task-plan.v1", id: "test", objective: "Write supported report",
    deliverable: { kind: "report", entries: ["report"] },
    resources: [
      { id: "report", path: "report.md", audience: "public", mutable: true },
      { id: "source", path: "source.txt", audience: "public", mutable: false },
      { id: "rubric", path: "private/rubric.txt", audience: "private", mutable: false },
    ],
    capabilities: ["read"], workers: [],
    windows: [
      { role: "lead", stage: "revise", reads: ["report", "source"], writes: ["report"], inline: [], actions: ["read", "edit"] },
      { role: "checker", stage: "accept", reads: ["report", "rubric"], writes: [], inline: [], actions: ["read"] },
    ],
    acceptance: { execution: "none", checks: [{ id: "check", target: "candidate", mechanism: "judge", purpose: "Check source support", required: true, resources: ["report", "rubric"], feedback: "status_only" }] },
    rejection: [{ check: "check", actions: ["research"] }], selection: { rule: "first_pass" },
    stop: { rounds: 2, calls: 10, tokens: 10000, stagnant: 1 },
  }
  return { root, plan }
}

test("physical binding preserves allowed candidate edits but blocks source drift", async () => {
  const { root, plan } = await fixture()
  const bound = await bindPlan(root, plan, ["read"])
  await writeFile(path.join(root, "report.md"), "improved report")
  await verifyBinding(bound)
  const view = await boundWindow(bound, "lead", "revise")
  expect(JSON.stringify(view)).not.toContain("private")
  expect(JSON.stringify(view)).not.toContain("rubric")
  expect(view.inline).toEqual([])
  await writeFile(path.join(root, "source.txt"), "changed source")
  await expect(verifyBinding(bound)).rejects.toThrow("drift")
})

test("binding rejects missing capabilities and a forged identity", async () => {
  const { root, plan } = await fixture()
  await expect(bindPlan(root, plan, [])).rejects.toThrow("Missing task capabilities")
  const bound = await bindPlan(root, plan, ["read"])
  await expect(verifyBinding({ ...bound, fingerprint: "forged" })).rejects.toThrow("fingerprint")
})

test("bound role view preserves only explicitly declared runtime feedback", async () => {
  const { root, plan } = await fixture()
  plan.windows[0].runtime = ["feedback"]
  const bound = await bindPlan(root, plan, ["read"])
  expect((await boundWindow(bound, "lead", "revise")).runtime).toEqual(["feedback"])
  expect((await boundWindow(bound, "checker", "accept")).runtime).toBeUndefined()
})

test("resource hardlink cannot alias a private grading file", async () => {
  const { root, plan } = await fixture()
  await link(path.join(root, "private/rubric.txt"), path.join(root, "alias.txt"))
  plan.resources[1].path = "alias.txt"
  await expect(bindPlan(root, plan, ["read"])).rejects.toThrow("Linked")
})

test("snapshot resumes the same identity after candidate edits and rejects goal drift", async () => {
  const { root, plan } = await fixture()
  const dir = path.join(root, "snapshot")
  const first = await freezePlan(dir, root, plan, ["read"])
  await writeFile(path.join(root, "report.md"), "revised")
  expect((await freezePlan(dir, root, plan, ["read"])).fingerprint).toBe(first.fingerprint)
  plan.objective = "Different research objective"
  await expect(freezePlan(dir, root, plan, ["read"])).rejects.toThrow("plan drift")
})

test("an interrupted snapshot claim is not silently regenerated", async () => {
  const { root, plan } = await fixture()
  const dir = path.join(root, "snapshot")
  await mkdir(dir)
  await writeFile(path.join(dir, "task-plan.started.claim"), "")
  await expect(freezePlan(dir, root, plan, ["read"])).rejects.toThrow()
})
