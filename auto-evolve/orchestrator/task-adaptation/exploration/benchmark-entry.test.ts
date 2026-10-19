import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { plan, policy } from "./policy.test"
import { requireBenchmarkExploration, requireBenchmarkCampaignExploration } from "./benchmark-entry"

test("unadapted benchmark refuses exploration sources before training, old inputs stay supported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-benchmark-entry-"))
  const file = path.join(root, "spec.json"), planPath = path.join(root, "plan.json")
  await writeFile(file, "{}")
  await expect(requireBenchmarkExploration(file, false)).resolves.toBeUndefined()
  await writeFile(file, JSON.stringify({ taskAdaptation: { schema: "aev.task-adaptation.v1", root, planPath,
    capabilities: [], entries: [{ id: "report", path: "report.md" }, { id: "facts", path: "facts.md" }] } }))
  await writeFile(planPath, JSON.stringify({ ...plan(), exploration: policy() }))
  await expect(requireBenchmarkExploration(file, false)).rejects.toThrow("selected-delivery")
  await expect(requireBenchmarkExploration(file, true)).resolves.toBeUndefined()
  const campaign = path.join(root, "campaign.json")
  const expected = path.join(root, "missing-fixed-spec.json")
  for (const baseSpecPath of ["spec.json", file]) {
    await writeFile(campaign, JSON.stringify({ title: "Bound source", baseSpecPath, maxRounds: 4 }))
    await expect(requireBenchmarkCampaignExploration(campaign, expected, false)).rejects.toThrow("selected-delivery")
    await expect(requireBenchmarkCampaignExploration(campaign, expected, true)).rejects.toThrow("selected-delivery")
    await expect(requireBenchmarkCampaignExploration(campaign, file, true)).resolves.toBeUndefined()
  }
  await writeFile(planPath, JSON.stringify(plan()))
  await expect(requireBenchmarkExploration(file, false)).resolves.toBeUndefined()
})
