import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { buildOfficeQADirectChatDataset } from "../orchestrator/direct-chat/dataset-bundler"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { extractAnswer, extractAnswerDetailed, runDirectChatEvaluation } from "../orchestrator/direct-chat/runner"
import type { DirectChatModelsConfig } from "../orchestrator/direct-chat/contract"

async function main() {
  const explicitOutput = extractAnswer(
    "I compared the country rows and excluded regional aggregates.\nI will output 103,375.\nMore text may be truncated.",
  )
  if (explicitOutput !== "103375") throw new Error(`Explicit output extraction mismatch: ${explicitOutput}`)
  const roundedOutput = extractAnswer(
    "Difference: 44,463 - 4,980.9714 = 39,482.0286 -> 39,482.03.\nThe model continued checking intermediate values.",
  )
  if (roundedOutput !== "39482.03") throw new Error(`Rounded output extraction mismatch: ${roundedOutput}`)
  const competingValues = extractAnswerDetailed(
    [
      "Total Value = 987,708,828,424",
      "Total Bills = 30,202,172,786",
      "Average = 32.7032376",
      "Rounded to nearest thousandths: 32.703",
      "The model continued checking 2011 and page 50.",
    ].join("\n"),
  )
  if (competingValues.answer !== "32.703" || competingValues.source !== "rounded_result") {
    throw new Error(`Candidate ranking mismatch: ${JSON.stringify(competingValues)}`)
  }
  const finalBeatsLaterSum = extractAnswer(
    "Final answer: 1608.80%\nFor reference, the source monthly sum is 44,463.",
  )
  if (finalBeatsLaterSum !== "1608.80%") throw new Error(`Final answer ranking mismatch: ${finalBeatsLaterSum}`)
  const numericBeforeExplanation = extractAnswer("Final answer: 44,463 because this is the monthly total.")
  if (numericBeforeExplanation !== "44463") throw new Error(`Numeric label extraction mismatch: ${numericBeforeExplanation}`)
  const taggedText = extractAnswer("<answer>United Kingdom</answer>\nTotal: 103,375")
  if (taggedText !== "United Kingdom") throw new Error(`Tagged text extraction mismatch: ${taggedText}`)
  const longReasoning = `${"Page 99 contains intermediate value 16.78. ".repeat(20)}No final answer was stated.`
  if (extractAnswer(longReasoning) !== longReasoning) {
    throw new Error("Long reasoning must not fall back to an unrelated trailing number")
  }

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
    caseIDs: ["ANS001"],
  })
  if (!result.results[0]?.passed) throw new Error("Answer extraction smoke did not pass")
  const answer = await Bun.file(path.join(root, "run", "results", "smoke", "ANS001", "answer.txt")).text()
  if (answer.trim() !== "[2017, 0.69]") throw new Error(`Extracted answer mismatch: ${answer}`)
  const extractionAudit = await readJsonFile<{ source: string; confidence: string }>(
    path.join(root, "run", "results", "smoke", "ANS001", "answer-extraction.json"),
  )
  if (extractionAudit.source !== "final_answer_label" || extractionAudit.confidence !== "high") {
    throw new Error(`Extraction audit mismatch: ${JSON.stringify(extractionAudit)}`)
  }
  const prompt = await Bun.file(path.join(root, "run", "results", "smoke", "ANS001", "prompt.system.txt")).text()
  if (!prompt.includes("The prompt has exactly three useful input sections")) throw new Error("Prompt role instructions missing")
  await readJsonFile(path.join(root, "run", "summary.json"))
  let missingCaseRejected = false
  try {
    await runDirectChatEvaluation({
      skillBundlePath: skill.bundlePath,
      datasetBundlePath: dataset.bundlePath,
      outDir: path.join(root, "missing-case-run"),
      models,
      caseIDs: ["DOES_NOT_EXIST"],
    })
  } catch (error) {
    missingCaseRejected = String(error).includes("case IDs not found")
  }
  if (!missingCaseRejected) throw new Error("Missing case ID must fail instead of running the full dataset")
  const unresolvedModels: DirectChatModelsConfig = {
    ...models,
    models: {
      unresolved: {
        provider: "mock",
        transport: "mock",
        mockResponse: `${"The document mentions page 99 and year 2011. ".repeat(30)}No conclusion was produced.`,
        concurrency: 1,
      },
    },
  }
  const unresolved = await runDirectChatEvaluation({
    skillBundlePath: skill.bundlePath,
    datasetBundlePath: dataset.bundlePath,
    outDir: path.join(root, "unresolved-run"),
    models: unresolvedModels,
    caseIDs: ["ANS001"],
  })
  if (unresolved.results[0]?.errorCategory !== "answer_extraction") {
    throw new Error(`Unresolved long response was not classified correctly: ${JSON.stringify(unresolved.results[0])}`)
  }
  console.log(`direct-chat answer extraction smoke passed: ${root}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
