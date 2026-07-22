import path from "node:path"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { decodeSkillPackage, encodeSkillDirectory, runSkillOptMerger } from "../orchestrator/multi-instance/skillopt-merger"
import { loadConfig } from "../orchestrator/schema"
import { parseBenchmarkConfig } from "./run-benchmark-orchestrator"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function expectFailure(run: () => Promise<unknown> | unknown, contains: string) {
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(message.includes(contains), `Expected failure containing ${JSON.stringify(contains)}, got ${message}`)
    return
  }
  throw new Error(`Expected failure containing ${JSON.stringify(contains)}`)
}

const cwd = path.resolve(import.meta.dir, "../..")
const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "merge-as-opt")
const sourceRoot = path.join(root, "source-skill")
const fakeSkillOptRoot = path.join(root, "fake-skillopt")
const runRoot = path.join(root, "run")

await rm(root, { recursive: true, force: true })
await mkdir(path.join(sourceRoot, "casebook"), { recursive: true })
await mkdir(path.join(sourceRoot, "tools"), { recursive: true })
await mkdir(path.join(fakeSkillOptRoot, "skillopt"), { recursive: true })
await mkdir(path.join(fakeSkillOptRoot, "configs"), { recursive: true })
await writeFile(path.join(sourceRoot, "INDEX.md"), "# Entry\n\nRead CORE.md first.\n", "utf8")
await writeFile(path.join(sourceRoot, "CORE.md"), "# Core\n\nUse evidence, not guesses.\n", "utf8")
await writeFile(path.join(sourceRoot, "casebook", "missing-formula.md"), "# Missing formula\n\nReconstruct dependencies.\n", "utf8")
await writeFile(path.join(sourceRoot, "tools", "helper.py"), "print('safe helper')\n", "utf8")
await writeFile(path.join(fakeSkillOptRoot, "configs", "merge.yaml"), "model:\n  optimizer: smoke-model\n", "utf8")

try {
  const encoded = await encodeSkillDirectory(sourceRoot)
  const decoded = decodeSkillPackage(encoded)
  assert(decoded.length === 4, `Expected 4 package files, got ${decoded.length}`)
  assert(decoded.some((item) => item.path === "casebook/missing-formula.md"), "Nested casebook path was lost")
  assert(decoded.some((item) => item.path === "tools/helper.py" && item.content.includes("safe helper")), "Script content was lost")

  await expectFailure(
    () => decodeSkillPackage('<!-- AEV_SKILL_FILE_START "../escape.md" -->\nno\n<!-- AEV_SKILL_FILE_END -->'),
    "unsafe path segment",
  )
  await expectFailure(
    () => decodeSkillPackage('<!-- AEV_SKILL_FILE_START "C:/escape.md" -->\nno\n<!-- AEV_SKILL_FILE_END -->'),
    "absolute or empty path",
  )
  await expectFailure(
    () =>
      decodeSkillPackage(
        '<!-- AEV_SKILL_FILE_START "CORE.md" -->\none\n<!-- AEV_SKILL_FILE_END -->\n' +
          '<!-- AEV_SKILL_FILE_START "core.md" -->\ntwo\n<!-- AEV_SKILL_FILE_END -->',
      ),
    "duplicate file path",
  )
  await expectFailure(
    () => decodeSkillPackage('unexpected preamble\n<!-- AEV_SKILL_FILE_START "CORE.md" -->\nno\n<!-- AEV_SKILL_FILE_END -->'),
    "outside the AEV file boundary",
  )
  await expectFailure(
    () => decodeSkillPackage('<!-- AEV_SKILL_FILE_START ".hidden.md" -->\nno\n<!-- AEV_SKILL_FILE_END -->'),
    "unsafe path segment",
  )

  const binaryRoot = path.join(root, "binary-skill")
  await mkdir(binaryRoot, { recursive: true })
  await writeFile(path.join(binaryRoot, "asset.bin"), new Uint8Array([1, 0, 2]))
  await expectFailure(() => encodeSkillDirectory(binaryRoot), "binary file")

  const symlinkRoot = path.join(root, "symlink-skill")
  await mkdir(symlinkRoot, { recursive: true })
  await writeFile(path.join(root, "outside.md"), "outside\n", "utf8")
  try {
    await symlink(path.join(root, "outside.md"), path.join(symlinkRoot, "linked.md"), "file")
    await expectFailure(() => encodeSkillDirectory(symlinkRoot), "cannot contain symlinks")
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "EPERM" && code !== "EACCES") throw error
  }

  const loaded = await loadConfig(cwd)
  assert(loaded.mergeConfig.mode === "legacy_script", "Existing default merge mode changed unexpectedly")
  assert(loaded.mergeConfig.asSkillOpt.batchSize === 8, "merge-as-opt total-control config did not load")
  assert(loaded.mergeConfig.asSkillOpt.enabled === false, "merge-as-opt must remain opt-in by default")
  assert(loaded.mergeConfig.asSkillOpt.pipelineMode === "aggregate_only", "merge-as-opt must preserve the historical default")

  const stopAfterMergeConfig = await parseBenchmarkConfig([
    "--task-pack-root",
    path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "officeqa-pro-learnbench"),
    "--out",
    path.join(root, "parse-config-only"),
    "--merge-execution-mode",
    "skillopt",
    "--skillopt-optimizer-backend",
    "minimax_chat",
    "--skillopt-optimizer-model",
    "MiniMax-M2.7",
    "--skillopt-pipeline-mode",
    "native-train",
    "--skillopt-native-config",
    "configs/officeqa/default.yaml",
    "--skillopt-native-epochs",
    "4",
    "--skillopt-native-batch-size",
    "40",
    "--skillopt-target-workers",
    "2",
    "--stop-after",
    "merge",
    "--dry-run",
  ])
  assert(stopAfterMergeConfig.mergeExecutionMode === "skillopt", "stop-after merge lost the merge-as-opt backend")
  assert(stopAfterMergeConfig.mergeAsSkillOpt?.enabled === true, "stop-after merge did not enable merge-as-opt")
  assert(
    stopAfterMergeConfig.mergeAsSkillOpt?.optimizerModel === "MiniMax-M2.7",
    "stop-after merge lost the SkillOpt optimizer overrides",
  )
  assert(stopAfterMergeConfig.mergeAsSkillOpt?.pipelineMode === "native_train", "stop-after merge lost native_train mode")
  assert(stopAfterMergeConfig.mergeAsSkillOpt?.nativeTrainEpochs === 4, "native SkillOpt epochs were not preserved")
  assert(stopAfterMergeConfig.mergeAsSkillOpt?.nativeTrainBatchSize === 40, "native SkillOpt batch size was not preserved")
  assert(stopAfterMergeConfig.mergeAsSkillOpt?.nativeTrainTargetWorkers === 2, "native target workers were not preserved")

  await expectFailure(
    () =>
      runSkillOptMerger({
        cwd,
        runRoot: path.join(root, "missing-native-config-run"),
        sourceSkills: [{ id: "verified-case-001", skillRoot: sourceRoot }],
        config: {
          ...loaded.mergeConfig.asSkillOpt,
          projectRoot: fakeSkillOptRoot,
          configPath: "configs/merge.yaml",
          pipelineMode: "native_train",
          nativeTrainConfigPath: "configs/missing-officeqa.yaml",
        },
        bridgeRunner: async () => {
          throw new Error("must not reach model bridge")
        },
      }),
    "nativeTrainConfigPath",
  )

  await expectFailure(
    () =>
      runSkillOptMerger({
        cwd,
        runRoot: path.join(root, "bad-batch-run"),
        sourceSkills: [{ id: "verified-case-001", skillRoot: sourceRoot }],
        config: {
          ...loaded.mergeConfig.asSkillOpt,
          projectRoot: fakeSkillOptRoot,
          configPath: "configs/merge.yaml",
          batchSize: 1,
        },
        bridgeRunner: async () => {
          throw new Error("must not reach model bridge")
        },
      }),
    "batchSize >= 2",
  )
  await expectFailure(
    () =>
      runSkillOptMerger({
        cwd,
        runRoot: path.join(root, "duplicate-id-run"),
        sourceSkills: [
          { id: "verified-case-001", skillRoot: sourceRoot },
          { id: "VERIFIED-CASE-001", skillRoot: sourceRoot },
        ],
        config: {
          ...loaded.mergeConfig.asSkillOpt,
          projectRoot: fakeSkillOptRoot,
          configPath: "configs/merge.yaml",
        },
        bridgeRunner: async () => {
          throw new Error("must not reach model bridge")
        },
      }),
    "duplicated",
  )

  const actualSkillOptRoot = path.resolve(loaded.mergeConfig.asSkillOpt.projectRoot)
  const actualSkillOptConfig = path.resolve(actualSkillOptRoot, loaded.mergeConfig.asSkillOpt.configPath)
  const actualRootExists = await readFile(path.join(actualSkillOptRoot, "skillopt", "__init__.py")).then(() => true).catch(() => false)
  const actualConfigExists = await readFile(actualSkillOptConfig).then(() => true).catch(() => false)
  if (actualRootExists && actualConfigExists) {
    const preflightRequestPath = path.join(root, "real-bridge-preflight-request.json")
    const preflightResultPath = path.join(root, "real-bridge-preflight-result.json")
    await writeFile(
      preflightRequestPath,
      JSON.stringify(
        {
          skillOptConfigPath: actualSkillOptConfig,
          optimizer: {
            backend: loaded.mergeConfig.asSkillOpt.optimizerBackend || undefined,
            model: loaded.mergeConfig.asSkillOpt.optimizerModel || undefined,
            baseUrl: loaded.mergeConfig.asSkillOpt.optimizerBaseUrl || undefined,
            apiKeyEnv: loaded.mergeConfig.asSkillOpt.optimizerApiKeyEnv || undefined,
            reasoningEffort: loaded.mergeConfig.asSkillOpt.reasoningEffort || undefined,
          },
          nativeTrain: {
            enabled: true,
            configPath: path.join(actualSkillOptRoot, "configs", "officeqa", "default.yaml"),
            splitDir: path.join(actualSkillOptRoot, "data", "officeqa_id_split"),
            dataDirs: [path.join(actualSkillOptRoot, "data", "officeqa_docs_official")],
            outRoot: path.join(root, "native-preflight-out"),
            epochs: 4,
            batchSize: 40,
            maxSteps: 0,
            evalTest: false,
            targetWorkers: 1,
          },
        },
        null,
        2,
      ),
      "utf8",
    )
    const preflight = Bun.spawn(
      [
        loaded.mergeConfig.asSkillOpt.pythonCommand,
        path.join(cwd, "auto-evolve", loaded.mergeConfig.asSkillOpt.bridgeScript),
        "--skillopt-root",
        actualSkillOptRoot,
        "--request",
        preflightRequestPath,
        "--result",
        preflightResultPath,
        "--preflight-only",
      ],
      { cwd: actualSkillOptRoot, stdout: "pipe", stderr: "pipe" },
    )
    const [preflightCode, preflightStderr] = await Promise.all([
      preflight.exited,
      new Response(preflight.stderr).text(),
    ])
    assert(preflightCode === 0, `Real SkillOpt bridge preflight failed: ${preflightStderr}`)
    const preflightResult = JSON.parse(await readFile(preflightResultPath, "utf8"))
    assert(preflightResult.passed === true, "Real SkillOpt bridge preflight result did not pass")
    assert(preflightResult.nativeTrainPreflight?.trainSize > 0, "Native SkillOpt train split did not load")
    assert(preflightResult.nativeTrainPreflight?.validationSize > 0, "Native SkillOpt validation split did not load")
  }

  const outcome = await runSkillOptMerger({
    cwd,
    runRoot,
    sourceSkills: [{ id: "verified-case-001", skillRoot: sourceRoot }],
    config: {
      ...loaded.mergeConfig.asSkillOpt,
      enabled: true,
      projectRoot: fakeSkillOptRoot,
      configPath: "configs/merge.yaml",
      optimizerApiKeyEnv: "SMOKE_SECRET_ENV",
    },
    bridgeRunner: async ({ request }) => ({
      schema: "auto-evolve/skillopt-merge-result/v1",
      passed: true,
      reasoning: "mocked hierarchical full-skill merge",
      mergedSkill: request.successPatches[0]!.skill_candidates[0]!.new_skill,
      tokenSummary: { total: 0 },
    }),
  })
  assert(outcome.contributingInstances.join(",") === "verified-case-001", "Source lineage was not preserved")
  assert((await readFile(path.join(outcome.mergedSkillDir, "CORE.md"), "utf8")).includes("Use evidence"), "CORE.md was not materialized")
  assert(await readFile(path.join(outcome.mergedSkillDir, "tools", "helper.py"), "utf8"), "Nested script was not materialized")
  const manifestRaw = await readFile(outcome.inputManifestPath, "utf8")
  assert(manifestRaw.includes("SMOKE_SECRET_ENV"), "API key environment variable name should be auditable")
  assert(!manifestRaw.includes("actual-secret-value"), "API key value leaked into merge manifest")
  const report = JSON.parse(await readFile(outcome.reportPath, "utf8"))
  assert(report.mergePath === "merge-as-opt", "merge-as-opt lineage marker missing")
  assert(report.pipelineMode === "aggregate_only", "merge-as-opt report lost pipeline mode")
  assert(report.outputFiles.length === 4, "Output file inventory is incomplete")

  console.log("smoke-merge-as-opt: passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
