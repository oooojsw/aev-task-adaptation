import path from "node:path"
import type { RunBaselineResult } from "../baseline-runner"
import { ensureDirectory, writeJsonFile, writeTextFile } from "../fs"
import { resolveExperienceWorkspaceLayout } from "../experience-workspace"
import {
  checkoutCommitToWorkspace,
  createCommitFromWorkspace,
  ensureCanonicalCommitFromLiveWorkspace,
  propagationPaths,
  readBranchRef,
  relativeToAutoEvolveRoot,
  resolvePropagationRef,
  sanitizeBranchName,
  type ExperienceCommitEvaluationSummary,
  type PropagationBranchRef,
} from "./repository"
import { resolvePropagationMethod } from "./methods"
import { loadConfig } from "../schema"

export interface RunPropagationOptions {
  methodID?: string
  maintenanceMethodID?: string
  sourceRef?: string
  branchName?: string
  trainLimit?: number
  testLimit?: number
}

export interface RunPropagationResult {
  campaignDir: string
  campaignID: string
  propagationMethodID: string
  maintenanceMethodID: string
  sourceCommitID: string
  branchName: string
  baselineDir: string
  candidateCommitID: string
  branchHeadCommitID: string
}

function makePropagationCampaignID() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-propagation`
}

function defaultBranchName(propagationMethodID: string, maintenanceMethodID: string, campaignID: string) {
  return sanitizeBranchName(`${propagationMethodID}-${maintenanceMethodID}-${campaignID}`)
}

function evaluationFromBaseline(result: RunBaselineResult): ExperienceCommitEvaluationSummary {
  return {
    train: {
      total: result.trainRound.totalCases,
      passed: result.trainRound.passedCases,
      failed: result.trainRound.failedCases,
      acceptedRefines: result.trainRound.acceptedRefines,
      rejectedRefines: result.trainRound.rejectedRefines,
    },
    test: {
      total: result.testRound.totalCases,
      passed: result.testRound.passedCases,
      failed: result.testRound.failedCases,
      acceptedRefines: result.testRound.acceptedRefines,
      rejectedRefines: result.testRound.rejectedRefines,
    },
  }
}

export async function runPropagation(cwd: string, options?: RunPropagationOptions): Promise<RunPropagationResult> {
  const config = await loadConfig(cwd)
  const requestedPropagationMethodID = options?.methodID ?? config.defaultPropagationMethod
  const trainLimit = Math.max(1, options?.trainLimit ?? 1)
  const testLimit = Math.max(1, options?.testLimit ?? 1)
  const repo = propagationPaths(cwd, config)
  const canonical = await ensureCanonicalCommitFromLiveWorkspace(cwd, config)
  const source = await resolvePropagationRef(cwd, config, options?.sourceRef ?? "canonical")
  const resolvedPropagationMethod = await resolvePropagationMethod(
    cwd,
    config,
    requestedPropagationMethodID,
    options?.maintenanceMethodID,
  )
  const propagationMethod = resolvedPropagationMethod.method
  const propagationMethodID = propagationMethod.id
  const maintenanceMethodID = resolvedPropagationMethod.maintenanceMethodID

  const campaignID = makePropagationCampaignID()
  const campaignDir = path.join(repo.campaignsRoot, campaignID)
  await ensureDirectory(campaignDir)

  const branchName = sanitizeBranchName(
    options?.branchName ?? defaultBranchName(propagationMethodID, maintenanceMethodID, campaignID),
  )
  const workspaceRoot = path.join(repo.workspacesRoot, branchName, "workspace")
  const runsRoot = path.join(repo.workspacesRoot, branchName, "runs")
  await ensureDirectory(path.dirname(workspaceRoot))
  await ensureDirectory(runsRoot)

  const checkedOut = await checkoutCommitToWorkspace(repo, config, source.commitID, workspaceRoot)
  const initialWorkspaceLayout = await resolveExperienceWorkspaceLayout(checkedOut.workspacePaths)
  const runtimePaths = {
    knowledgeDir: relativeToAutoEvolveRoot(cwd, checkedOut.workspacePaths.root),
    runsDir: relativeToAutoEvolveRoot(cwd, runsRoot),
  }

  const existingBranch = await readBranchRef(repo, branchName)
  const branchRef: PropagationBranchRef = {
    name: branchName,
    sourceCommitID: existingBranch?.sourceCommitID ?? source.commitID,
    headCommitID: source.commitID,
    createdAt: existingBranch?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
  }
  await writeJsonFile(path.join(repo.branchesRoot, `${branchName}.json`), branchRef)

  await writeJsonFile(path.join(campaignDir, "campaign.input.json"), {
    campaignID,
    propagationMethodID,
    maintenanceMethodID,
    sourceRef: source.sourceRef,
    sourceCommitID: source.commitID,
    canonicalHeadAtStart: canonical.commit.id,
    branchName,
    runtimePaths,
    initialWorkspaceDocuments: initialWorkspaceLayout.documents.map((item) =>
      relativeToAutoEvolveRoot(cwd, item.absolutePath),
    ),
    initialWorkspaceAssets: initialWorkspaceLayout.assets.map((item) =>
      relativeToAutoEvolveRoot(cwd, item.absolutePath),
    ),
    initialRuntimeSidecarFiles: initialWorkspaceLayout.runtimeSidecarFiles.map((filePath) =>
      relativeToAutoEvolveRoot(cwd, filePath),
    ),
    trainLimit,
    testLimit,
  })

  const methodResult = await propagationMethod.run({
    cwd,
    config,
    propagation: repo,
    campaignID,
    campaignDir,
    branchName,
    sourceCommitID: source.commitID,
    maintenanceMethodID,
    runtimePaths,
    trainLimit,
    testLimit,
  })

  const finalWorkspaceLayout = await resolveExperienceWorkspaceLayout(checkedOut.workspacePaths)
  const candidateCommit = await createCommitFromWorkspace(repo, checkedOut.workspacePaths, {
    parentCommitID: source.commitID,
    summary: `Propagation campaign ${campaignID} via ${propagationMethodID} and ${maintenanceMethodID}`,
    source: {
      kind: "campaign_result",
      description: "Candidate produced by propagation campaign",
      campaignID,
      branchName,
      maintenanceMethodID,
      propagationMethodID,
      baselineDir: methodResult.baseline.baselineDir,
    },
    evaluation: evaluationFromBaseline(methodResult.baseline),
  })

  const updatedBranchRef: PropagationBranchRef = {
    ...branchRef,
    headCommitID: candidateCommit.id,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonFile(path.join(repo.branchesRoot, `${branchName}.json`), updatedBranchRef)

  await writeJsonFile(path.join(campaignDir, "campaign.json"), {
    campaignID,
    propagationMethodID,
    propagationMethodDocPath: propagationMethod.docPath,
    maintenanceMethodID,
    sourceRef: source.sourceRef,
    sourceCommitID: source.commitID,
    candidateCommitID: candidateCommit.id,
    branchName,
    branchHeadCommitID: updatedBranchRef.headCommitID,
    baselineDir: methodResult.baseline.baselineDir,
    branchWorkspaceDocuments: finalWorkspaceLayout.documents.map((item) =>
      relativeToAutoEvolveRoot(cwd, item.absolutePath),
    ),
    branchWorkspaceAssets: finalWorkspaceLayout.assets.map((item) =>
      relativeToAutoEvolveRoot(cwd, item.absolutePath),
    ),
    branchWorkspaceRuntimeSidecarFiles: finalWorkspaceLayout.runtimeSidecarFiles.map((filePath) =>
      relativeToAutoEvolveRoot(cwd, filePath),
    ),
    trainRound: methodResult.baseline.trainRound,
    testRound: methodResult.baseline.testRound,
  })

  await writeTextFile(
    path.join(campaignDir, "campaign-summary.md"),
    [
      "# Propagation Campaign Summary",
      "",
      `- campaign: ${campaignID}`,
      `- propagation method: ${propagationMethodID}`,
      `- propagation method doc: ${propagationMethod.docPath}`,
      `- maintenance method: ${maintenanceMethodID}`,
      `- source ref: ${source.sourceRef}`,
      `- source commit: ${source.commitID}`,
      `- candidate commit: ${candidateCommit.id}`,
      `- branch: ${branchName}`,
      `- branch head: ${updatedBranchRef.headCommitID}`,
      `- baseline dir: ${methodResult.baseline.baselineDir}`,
      "",
      "## Workspace Planes",
      "",
      `- tracked documents: ${finalWorkspaceLayout.documents.length}`,
      `- tracked helper assets: ${finalWorkspaceLayout.assets.length}`,
      `- runtime sidecar files preserved locally and excluded from candidate commit: ${finalWorkspaceLayout.runtimeSidecarFiles.length}`,
      ...(finalWorkspaceLayout.runtimeSidecarFiles.length > 0
        ? [
            "",
            "### Runtime Sidecar Files",
            "",
            ...finalWorkspaceLayout.runtimeSidecarFiles.map(
              (filePath) => `- ${relativeToAutoEvolveRoot(cwd, filePath)}`,
            ),
            "",
          ]
        : []),
      "- Candidate commits in the third layer still snapshot only the tracked experience plane.",
      "- Runtime sidecar files remain local to the branch workspace and do not participate in commit diff, merge, rollback, or promotion.",
      "",
      "## Train",
      "",
      `- passed: ${methodResult.baseline.trainRound.passedCases}/${methodResult.baseline.trainRound.totalCases}`,
      `- accepted refines: ${methodResult.baseline.trainRound.acceptedRefines}`,
      `- rejected refines: ${methodResult.baseline.trainRound.rejectedRefines}`,
      "",
      "## Test",
      "",
      `- passed: ${methodResult.baseline.testRound.passedCases}/${methodResult.baseline.testRound.totalCases}`,
      `- accepted refines: ${methodResult.baseline.testRound.acceptedRefines}`,
      `- rejected refines: ${methodResult.baseline.testRound.rejectedRefines}`,
      "",
      "## Current Scope",
      "",
      "- This initial third-layer implementation creates one experimental branch, runs one delegated second-layer method on that branch, and records the resulting candidate commit.",
      "- It does not yet perform merge, promotion, or multi-branch comparison.",
      "",
    ].join("\n"),
  )

  return {
    campaignDir,
    campaignID,
    propagationMethodID,
    maintenanceMethodID,
    sourceCommitID: source.commitID,
    branchName,
    baselineDir: methodResult.baseline.baselineDir,
    candidateCommitID: candidateCommit.id,
    branchHeadCommitID: updatedBranchRef.headCommitID,
  }
}
