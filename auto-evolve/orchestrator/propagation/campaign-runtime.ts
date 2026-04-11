import path from "node:path"
import { pathExists, readJsonFile, writeJsonFile } from "../fs"

export type PropagationCampaignPhase =
  | "created"
  | "source_resolved"
  | "workspace_materialized"
  | "execution_started"
  | "execution_finished"
  | "candidate_commit_created"
  | "branch_updated"
  | "finalized"
  | "failed"
  | "aborted"

export interface PropagationCampaignState {
  campaignID: string
  updatedAt: string
  phase: PropagationCampaignPhase
  propagationMethodID?: string
  maintenanceMethodID?: string
  sourceRef?: string
  sourceKind?: string
  sourceCommitID?: string
  sourceOptimizationCandidateID?: string | null
  branchName?: string
  workspaceRoot?: string
  runsRoot?: string
  runtimeKnowledgeDir?: string
  runtimeRunsDir?: string
  executionStageDir?: string
  executionResultPath?: string
  baselineDir?: string
  candidateCommitID?: string
  branchHeadCommitID?: string
  errorMessage?: string
}

function nowISO() {
  return new Date().toISOString()
}

export function campaignStatePath(campaignDir: string) {
  return path.join(campaignDir, "campaign.state.json")
}

export async function readCampaignState(campaignDir: string) {
  const target = campaignStatePath(campaignDir)
  if (!(await pathExists(target))) return undefined
  return readJsonFile<PropagationCampaignState>(target)
}

export async function writeCampaignState(campaignDir: string, state: PropagationCampaignState) {
  await writeJsonFile(campaignStatePath(campaignDir), state)
  return state
}

export async function updateCampaignState(
  campaignDir: string,
  patch: Partial<PropagationCampaignState> & Pick<PropagationCampaignState, "campaignID" | "phase">,
) {
  const current = await readCampaignState(campaignDir)
  const next: PropagationCampaignState = {
    campaignID: patch.campaignID,
    updatedAt: nowISO(),
    phase: patch.phase,
    ...(current ?? {}),
    ...patch,
    updatedAt: nowISO(),
  }
  await writeCampaignState(campaignDir, next)
  return next
}
