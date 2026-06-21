import path from "node:path"
import { rm, writeFile } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { buildOfficeQADirectChatDataset } from "../orchestrator/direct-chat/dataset-bundler"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runDirectChatEvaluation } from "../orchestrator/direct-chat/runner"
import type { DirectChatModelsConfig } from "../orchestrator/direct-chat/contract"

async function createSmokeTask(root: string) {
  const taskPackRoot = path.join(root, "officeqa-smoke")
  const taskDir = path.join(taskPackRoot, "tasks", "SMOKE001")
  const privateDir = path.join(taskPackRoot, "private-answers", "SMOKE001")
  const skillRoot = path.join(root, "skill")
  await ensureDirectory(taskDir)
  await ensureDirectory(privateDir)
  await ensureDirectory(skillRoot)
  await writeTextFile(
    path.join(taskDir, "instruction.md"),
    [
      "OfficeQA Pro task SMOKE001",
      "",
      "Question: What is the hidden smoke-test answer?",
      "",
      "Difficulty: smoke",
      "",
      "Local source PDFs:",
    ].join("\n"),
  )
  await writeTextFile(path.join(privateDir, "answer.txt"), "42\n")
  const rewardPath = path.join(taskPackRoot, "reward.py")
  await writeTextFile(
    rewardPath,
    [
      "def score_answer(ground_truth, predicted, tolerance=0.01):",
      "    return 1.0 if str(ground_truth).strip() == str(predicted).strip() else 0.0",
    ].join("\n"),
  )
  const validatorPath = path.resolve(import.meta.dir, "validate-officeqa-answer.py")
  await writeJsonFile(path.join(taskDir, "spec.json"), {
    id: "SMOKE001",
    validators: [
      {
        id: "officeqa-answer-validate",
        path: validatorPath,
        args: [
          "--answer-path",
          "../../private-answers/SMOKE001/answer.txt",
          "--candidate",
          "./workspace/answer.txt",
          "--reward",
          rewardPath,
          "--tolerance",
          "0.01",
        ],
      },
    ],
  })
  await writeJsonFile(path.join(taskPackRoot, "split.json"), ["SMOKE001"])
  await writeTextFile(path.join(skillRoot, "INDEX.md"), "# Smoke skill\n\nAnswer directly when the material contains a simple smoke question.\n")
  return { taskPackRoot, skillRoot }
}

async function main() {
  const root = path.resolve(import.meta.dir, "..", ".tmp-direct-chat-smoke", String(Date.now()))
  await rm(root, { recursive: true, force: true })
  const { taskPackRoot, skillRoot } = await createSmokeTask(root)
  const outDir = path.join(root, "run")
  const skill = await buildSkillBundle({ skillRoot, outDir })
  const dataset = await buildOfficeQADirectChatDataset({
    taskPackRoot,
    splitPath: path.join(taskPackRoot, "split.json"),
    outDir,
  })
  const models: DirectChatModelsConfig = {
    models: {
      smoke: {
        transport: "mock",
        provider: "mock",
        mockResponse: "42",
        concurrency: 1,
      },
    },
    concurrency: { global: 1 },
    retry: { maxAttempts: 1, backoffMs: 1 },
  }
  const modelsConfigPath = path.join(outDir, "models.json")
  await writeJsonFile(modelsConfigPath, models)
  const result = await runDirectChatEvaluation({
    skillBundlePath: skill.bundlePath,
    datasetBundlePath: dataset.bundlePath,
    outDir,
    models,
  })
  if (result.results.length !== 1 || !result.results[0].passed) throw new Error("Direct chat smoke run did not pass")
  if (result.results[0].skillTier !== "full") throw new Error("Direct chat smoke did not use the configured full skill tier")
  const promptSystem = await Bun.file(path.join(outDir, "results", "smoke", "SMOKE001", "prompt.system.txt")).text()
  const promptUser = await Bun.file(path.join(outDir, "results", "smoke", "SMOKE001", "prompt.user.txt")).text()
  if ((promptSystem + promptUser).includes("private-answers")) throw new Error("Prompt leaked private answer path")
  const summary = await readJsonFile(path.join(outDir, "summary.json"))
  if (!summary?.summary?.[0]?.passed) throw new Error("Summary missing pass count")
  if (summary?.validity?.status !== "valid") throw new Error("Summary did not preserve run validity")
  const promptAudit = await readJsonFile<any>(path.join(outDir, "results", "smoke", "SMOKE001", "prompt-audit.json"))
  if (promptAudit.skill.truncated || promptAudit.skill.selectionTruncated) throw new Error("Full skill was unexpectedly truncated")
  if (promptAudit.materials.some((material: any) => material.truncated)) throw new Error("Prompt material was unexpectedly truncated")

  const noSkillOutDir = path.join(root, "run-no-skill")
  const noSkillResult = await runDirectChatEvaluation({
    skillBundlePath: skill.bundlePath,
    datasetBundlePath: dataset.bundlePath,
    outDir: noSkillOutDir,
    models,
    noSkillOnly: true,
  })
  if (noSkillResult.results.length !== 1 || noSkillResult.results[0].skillMode !== "no-skill") {
    throw new Error("No-skill Direct Chat smoke did not produce exactly one baseline result")
  }
  const noSkillSystem = await Bun.file(
    path.join(noSkillOutDir, "results", "smoke__no-skill", "SMOKE001", "prompt.system.txt"),
  ).text()
  if (/\bskill\b|<SKILL>|expert guidance/i.test(noSkillSystem)) {
    throw new Error("No-skill baseline prompt still contains skill-specific instructions")
  }
  const noSkillResultPath = path.join(
    noSkillOutDir,
    "results",
    "smoke__no-skill",
    "SMOKE001",
    "result.json",
  )
  const interruptedResult = await readJsonFile<any>(noSkillResultPath)
  await writeJsonFile(noSkillResultPath, {
    ...interruptedResult,
    passed: false,
    score: 0,
    error: "simulated transient network interruption",
    errorCategory: "network",
  })
  const recovered = await runDirectChatEvaluation({
    skillBundlePath: skill.bundlePath,
    datasetBundlePath: dataset.bundlePath,
    outDir: noSkillOutDir,
    models: {
      ...models,
      transientRecovery: {
        enabled: true,
        maxRounds: 1,
        delayMs: 0,
        categories: ["network"],
      },
    },
    noSkillOnly: true,
    resumeExisting: true,
  })
  if (!recovered.results[0]?.passed) throw new Error("Transient recovery did not replace the simulated network failure")
  const recoveryAudit = await readJsonFile<any>(path.join(noSkillOutDir, "transient-recovery.json"))
  if (recoveryAudit.rounds?.[0]?.attempted !== 1 || recoveryAudit.rounds?.[0]?.stillTransient !== 0) {
    throw new Error("Transient recovery audit did not record the recovered case")
  }

  const omittedTaskRoot = path.join(root, "omitted")
  const omittedTaskDir = path.join(omittedTaskRoot, "tasks", "PDF001")
  await ensureDirectory(omittedTaskDir)
  await writeTextFile(
    path.join(omittedTaskDir, "instruction.md"),
    "Question: blocked?\n\nLocal source PDFs:\n- ./materials/source.pdf\n",
  )
  await writeJsonFile(path.join(omittedTaskDir, "spec.json"), { validators: [] })
  await writeJsonFile(path.join(omittedTaskRoot, "split.json"), ["PDF001"])
  let blocked = false
  try {
    await buildOfficeQADirectChatDataset({
      taskPackRoot: omittedTaskRoot,
      splitPath: path.join(omittedTaskRoot, "split.json"),
      outDir: path.join(root, "omitted-run"),
    })
  } catch {
    blocked = true
  }
  if (!blocked) throw new Error("Omitted material guard did not block")
  await writeFile(path.join(outDir, "SMOKE_OK.txt"), "ok\n", "utf8")
  console.log(`direct-chat smoke passed: ${outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
