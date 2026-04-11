import path from "node:path"
import { runBaseline } from "../baseline-runner"
import { autoEvolvePath, ensureDirectory, pathExists, writeJsonFile, writeTextFile } from "../fs"
import type { AutoEvolveConfig, RuntimePathOverrides } from "../schema"
import type { RunBaselineResult } from "../baseline-runner"
import type { PropagationPaths } from "./repository"
import { methodPaths } from "../methods"

export interface PropagationMethodContext {
  cwd: string
  config: AutoEvolveConfig
  propagation: PropagationPaths
  campaignID: string
  campaignDir: string
  branchName: string
  sourceCommitID: string
  maintenanceMethodID: string
  runtimePaths: RuntimePathOverrides
  trainLimit: number
  testLimit: number
}

export interface PropagationMethodResult {
  methodID: string
  docPath: string
  baseline: RunBaselineResult
  stageDir: string
  executionResultPath: string
}

export interface PropagationMethod {
  id: string
  docPath: string
  run(context: PropagationMethodContext): Promise<PropagationMethodResult>
}

export interface ResolvedPropagationMethod {
  method: PropagationMethod
  maintenanceMethodID: string
}

class SingleBranchBaselineMethod implements PropagationMethod {
  id = "single-branch-baseline"

  constructor(public docPath: string) {}

  async run(context: PropagationMethodContext): Promise<PropagationMethodResult> {
    const stageDir = path.join(context.campaignDir, "single-branch-baseline")
    await ensureDirectory(stageDir)

    const baseline = await runBaseline(context.cwd, {
      methodID: context.maintenanceMethodID,
      trainLimit: context.trainLimit,
      testLimit: context.testLimit,
      skipBootstrap: true,
      runtimePaths: context.runtimePaths,
    })

    const executionResultPath = path.join(stageDir, "method_result.json")

    await writeJsonFile(executionResultPath, {
      propagationMethodID: this.id,
      maintenanceMethodID: context.maintenanceMethodID,
      sourceCommitID: context.sourceCommitID,
      branchName: context.branchName,
      baselineDir: baseline.baselineDir,
      trainRound: baseline.trainRound,
      testRound: baseline.testRound,
    })

    await writeTextFile(
      path.join(stageDir, "method_result.md"),
      [
        "# Single-Branch Baseline Result",
        "",
        `- propagation method: ${this.id}`,
        `- maintenance method: ${context.maintenanceMethodID}`,
        `- source commit: ${context.sourceCommitID}`,
        `- branch: ${context.branchName}`,
        `- baseline dir: ${baseline.baselineDir}`,
        "",
        "## Train",
        "",
        `- passed: ${baseline.trainRound.passedCases}/${baseline.trainRound.totalCases}`,
        `- accepted refines: ${baseline.trainRound.acceptedRefines}`,
        `- rejected refines: ${baseline.trainRound.rejectedRefines}`,
        "",
        "## Test",
        "",
        `- passed: ${baseline.testRound.passedCases}/${baseline.testRound.totalCases}`,
        `- accepted refines: ${baseline.testRound.acceptedRefines}`,
        `- rejected refines: ${baseline.testRound.rejectedRefines}`,
        "",
      ].join("\n"),
    )

    return {
      methodID: this.id,
      docPath: this.docPath,
      baseline,
      stageDir,
      executionResultPath,
    }
  }
}

class DelegatedLayer2Method implements PropagationMethod {
  constructor(
    public id: string,
    public docPath: string,
  ) {}

  async run(context: PropagationMethodContext): Promise<PropagationMethodResult> {
    const stageDir = path.join(context.campaignDir, "delegated-layer2")
    await ensureDirectory(stageDir)

    const baseline = await runBaseline(context.cwd, {
      methodID: this.id,
      trainLimit: context.trainLimit,
      testLimit: context.testLimit,
      skipBootstrap: true,
      runtimePaths: context.runtimePaths,
    })

    const executionResultPath = path.join(stageDir, "method_result.json")

    await writeJsonFile(executionResultPath, {
      propagationMethodID: this.id,
      delegatedLayer2MethodID: this.id,
      sourceCommitID: context.sourceCommitID,
      branchName: context.branchName,
      baselineDir: baseline.baselineDir,
      trainRound: baseline.trainRound,
      testRound: baseline.testRound,
    })

    await writeTextFile(
      path.join(stageDir, "method_result.md"),
      [
        "# Delegated Layer-2 Propagation Result",
        "",
        `- propagation method: ${this.id}`,
        `- delegated layer-2 method: ${this.id}`,
        `- source commit: ${context.sourceCommitID}`,
        `- branch: ${context.branchName}`,
        `- baseline dir: ${baseline.baselineDir}`,
        "",
        "## Train",
        "",
        `- passed: ${baseline.trainRound.passedCases}/${baseline.trainRound.totalCases}`,
        `- accepted refines: ${baseline.trainRound.acceptedRefines}`,
        `- rejected refines: ${baseline.trainRound.rejectedRefines}`,
        "",
        "## Test",
        "",
        `- passed: ${baseline.testRound.passedCases}/${baseline.testRound.totalCases}`,
        `- accepted refines: ${baseline.testRound.acceptedRefines}`,
        `- rejected refines: ${baseline.testRound.rejectedRefines}`,
        "",
      ].join("\n"),
    )

    return {
      methodID: this.id,
      docPath: this.docPath,
      baseline,
      stageDir,
      executionResultPath,
    }
  }
}

export function propagationMethodDocPath(cwd: string, config: AutoEvolveConfig, methodID: string) {
  return autoEvolvePath(cwd, config.propagationMethodsDir, `${methodID}.md`)
}

export async function resolvePropagationMethod(
  cwd: string,
  config: AutoEvolveConfig,
  methodID: string,
  maintenanceMethodID?: string,
): Promise<ResolvedPropagationMethod> {
  const docPath = propagationMethodDocPath(cwd, config, methodID)

  switch (methodID) {
    case "single-branch-baseline":
      return {
        method: new SingleBranchBaselineMethod(docPath),
        maintenanceMethodID: maintenanceMethodID ?? config.defaultMethod,
      }
    default:
      break
  }

  const layer2Method = methodPaths(cwd, config, methodID)
  if (await pathExists(layer2Method.methodDocPath)) {
    if (maintenanceMethodID && maintenanceMethodID !== methodID) {
      throw new Error(
        `Propagation method ${methodID} directly delegates the second-layer method of the same name. Omit --maintenance-method or set it to ${methodID}.`,
      )
    }
    return {
      method: new DelegatedLayer2Method(methodID, layer2Method.methodDocPath),
      maintenanceMethodID: methodID,
    }
  }

  throw new Error(`No code-defined propagation method is registered for method: ${methodID}`)
}
