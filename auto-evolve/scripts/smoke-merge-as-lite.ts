import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { runLiteMerger } from "../orchestrator/multi-instance/lite-merger"
import { loadConfig, type LoadedMergeAsLiteConfig } from "../orchestrator/schema"

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const root = await mkdtemp(path.join(os.tmpdir(), "aev-merge-as-lite-"))
try {
  const loaded = await loadConfig(process.cwd())
  check(loaded.mergeConfig.asLite.bridgeScript === "scripts/skillopt-lite-merge-bridge.py", "project Lite config was not loaded")
  const officialRoot = path.join(root, "official-lite")
  const runtimeRoot = path.join(root, "runtime")
  const prompt = path.join(officialRoot, "copilot_example", "officeqa", ".github", "prompts", "skillopt-loop.prompt.md")
  const runner = path.join(runtimeRoot, "tools", "lite_minimax_runner.py")
  const splitDir = path.join(runtimeRoot, "data", "officeqa_id_split")
  const dataRoot = path.join(root, "materials")
  const authFile = path.join(root, "auth.json")
  const sourceA = path.join(root, "source-a")
  const sourceB = path.join(root, "source-b")
  await Promise.all([
    mkdir(path.dirname(prompt), { recursive: true }),
    mkdir(path.dirname(runner), { recursive: true }),
    mkdir(splitDir, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(sourceA, { recursive: true }),
    mkdir(sourceB, { recursive: true }),
  ])
  await Promise.all([
    writeFile(prompt, "official prompt\n", "utf8"),
    writeFile(runner, "# runtime stub\n", "utf8"),
    writeFile(authFile, "{}\n", "utf8"),
    writeFile(path.join(sourceA, "CORE.md"), "# A\nverified rule A\n", "utf8"),
    writeFile(path.join(sourceB, "CORE.md"), "# B\nverified rule B\n", "utf8"),
  ])

  const config: LoadedMergeAsLiteConfig = {
    enabled: true,
    projectRoot: officialRoot,
    runtimeRoot,
    outputRoot: "",
    pythonCommand: "python",
    bridgeScript: "unused-in-injected-smoke.py",
    environment: "officeqa",
    splitDir,
    dataRoot,
    rounds: 3,
    workers: 2,
    timeoutMs: 60_000,
    optimizerModel: "MiniMax-M2.7",
    authFile,
    providerID: "smoke-provider",
    maxSkillBytes: 24,
    lengthRepairAttempts: 5,
    gateMetric: "hard",
  }
  const outcome = await runLiteMerger({
    cwd: root,
    runRoot: path.join(root, "run"),
    config,
    sourceSkills: [
      { id: "A", skillRoot: sourceA },
      { id: "B", skillRoot: sourceB },
    ],
    bridgeRunner: async ({ request }) => {
      check(request.sourceSkills.length === 2, "adapter did not receive both verified source Skills")
      check(request.policy.acceptance === "strict_validation_improvement", "strict Lite gate policy is missing")
      check(request.policy.heldoutTestDuringMerge === false, "merge adapter must not touch held-out test")
      return {
        schema: "auto-evolve/skillopt-lite-merge-result/v1",
        passed: true,
        mergedSkill: '<!-- AEV_SKILL_FILE_START "CORE.md" -->\n# Lite merged\n\nA and B\n<!-- AEV_SKILL_FILE_END -->',
        baselineScore: 0.25,
        bestScore: 0.5,
        bestRound: 2,
        gateLedger: [{ round: 1, action: "reject" }, { round: 2, action: "accept_new_best" }],
      }
    },
  })
  const merged = await readFile(path.join(outcome.mergedSkillDir, "CORE.md"), "utf8")
  const unchangedPrompt = await readFile(prompt, "utf8")
  check(merged.includes("Lite merged"), "best Lite candidate was not materialized")
  check(unchangedPrompt === "official prompt\n", "official Lite checkout was modified")
  check(outcome.contributingInstances.join(",") === "A,B", "source lineage was not preserved")
  console.log(JSON.stringify({ ok: true, mergePath: "merge-as-lite", output: outcome.mergedSkillDir }))
} finally {
  await rm(root, { recursive: true, force: true })
}
