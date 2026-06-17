import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { buildOfficeQADirectChatDataset } from "../orchestrator/direct-chat/dataset-bundler"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runDirectChatEvaluation } from "../orchestrator/direct-chat/runner"
import type { DirectChatModelsConfig } from "../orchestrator/direct-chat/contract"

async function main() {
  const root = path.resolve(import.meta.dir, "..", ".tmp-direct-chat-answer-extraction", String(Date.now()))
  await rm(root, { recursive: true, force: true })
  const taskPackRoot = path.join(root, "officeqa")
  const taskDir = path.join(taskPackRoot, "tasks", "ANS001")
  const privateDir = path.join(taskPackRoot, "private-answers", "ANS001")
  const skillRoot = path.join(root, "skill")
  await ensureDirectory(taskDir)
  await ensureDirectory(privateDir)
  await ensureDirectory(skillRoot)
  await writeTextFile(path.join(taskDir, "instruction.md"), "Question: Return the final JSON pair.\n")
  await writeTextFile(path.join(privateDir, "answer.txt"), "[2017, 0.69]\n")
  const rewardPath = path.join(taskPackRoot, "reward.py")
  await writeTextFile(
    rewardPath,
    [
      "def score_answer(ground_truth, predicted, tolerance=0.01):",
      "    import json",
      "    return 1.0 if json.loads(ground_truth) == json.loads(predicted) else 0.0",
    ].join("\n"),
  )
  await writeJsonFile(path.join(taskDir, "spec.json"), {
    id: "ANS001",
    validators: [
      {
        id: "officeqa-answer-validate",
        path: path.resolve(import.meta.dir, "validate-officeqa-answer.py"),
        args: [
          "--answer-path",
          "../../private-answers/ANS001/answer.txt",
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
  await writeJsonFile(path.join(taskPackRoot, "split.json"), ["ANS001"])
  await writeTextFile(path.join(skillRoot, "INDEX.md"), "# Skill\n\nReturn the requested answer exactly.\n")
  const skill = await buildSkillBundle({ skillRoot, outDir: root })
  const dataset = await buildOfficeQADirectChatDataset({
    taskPackRoot,
    splitPath: path.join(taskPackRoot, "split.json"),
    outDir: root,
  })
  const models: DirectChatModelsConfig = {
    models: {
      smoke: {
        provider: "mock",
        transport: "mock",
        mockResponse: "I checked the materials.\n\nFinal answer: [2017, 0.69]",
        concurrency: 1,
      },
    },
    concurrency: { global: 1 },
    retry: { maxAttempts: 1, backoffMs: 1 },
  }
  const result = await runDirectChatEvaluation({
    skillBundlePath: skill.bundlePath,
    datasetBundlePath: dataset.bundlePath,
    outDir: path.join(root, "run"),
    models,
  })
  if (!result.results[0]?.passed) throw new Error("Answer extraction smoke did not pass")
  const answer = await Bun.file(path.join(root, "run", "results", "smoke", "ANS001", "answer.txt")).text()
  if (answer.trim() !== "[2017, 0.69]") throw new Error(`Extracted answer mismatch: ${answer}`)
  const prompt = await Bun.file(path.join(root, "run", "results", "smoke", "ANS001", "prompt.system.txt")).text()
  if (!prompt.includes("The prompt has exactly three useful input sections")) throw new Error("Prompt role instructions missing")
  await readJsonFile(path.join(root, "run", "summary.json"))
  console.log(`direct-chat answer extraction smoke passed: ${root}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
