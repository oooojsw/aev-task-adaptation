import path from "node:path"
import { pathExists, readJsonFile } from "../fs"
import type { LongTaskBudgets } from "../long-task/contract"
import {
  DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER,
  type LongTaskCampaignCarryoverConfig,
  type LongTaskCampaignSpec,
} from "./contract"

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function normalizeMaybeString(input: unknown) {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined
}

function resolveMaybePath(baseDir: string, input: string) {
  return path.isAbsolute(input) ? input : path.resolve(baseDir, input)
}

function normalizeCarryover(raw: unknown): LongTaskCampaignCarryoverConfig {
  if (!isObject(raw)) return { ...DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER }
  return {
    includeCampaignOperationalMemory:
      typeof raw.includeCampaignOperationalMemory === "boolean"
        ? raw.includeCampaignOperationalMemory
        : DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER.includeCampaignOperationalMemory,
    includeCampaignSeedContext:
      typeof raw.includeCampaignSeedContext === "boolean"
        ? raw.includeCampaignSeedContext
        : DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER.includeCampaignSeedContext,
    includeFailurePackets:
      typeof raw.includeFailurePackets === "boolean"
        ? raw.includeFailurePackets
        : DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER.includeFailurePackets,
    includeRetryLessons:
      typeof raw.includeRetryLessons === "boolean"
        ? raw.includeRetryLessons
        : DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER.includeRetryLessons,
    includeLearningUnits:
      typeof raw.includeLearningUnits === "boolean"
        ? raw.includeLearningUnits
        : DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER.includeLearningUnits,
    includeRoundSummaries:
      typeof raw.includeRoundSummaries === "boolean"
        ? raw.includeRoundSummaries
        : DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER.includeRoundSummaries,
    recentRoundSummaryCount:
      typeof raw.recentRoundSummaryCount === "number" && raw.recentRoundSummaryCount > 0
        ? raw.recentRoundSummaryCount
        : DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER.recentRoundSummaryCount,
  }
}

function normalizeBudgets(raw: unknown): Partial<LongTaskBudgets> | undefined {
  if (!isObject(raw)) return undefined
  const next: Partial<LongTaskBudgets> = {}
  if (typeof raw.maxAttemptsPerUnit === "number" && raw.maxAttemptsPerUnit > 0) {
    next.maxAttemptsPerUnit = raw.maxAttemptsPerUnit
  }
  if (typeof raw.maxTotalUnitAttempts === "number" && raw.maxTotalUnitAttempts > 0) {
    next.maxTotalUnitAttempts = raw.maxTotalUnitAttempts
  }
  if (typeof raw.maxGraphReplans === "number" && raw.maxGraphReplans >= 0) {
    next.maxGraphReplans = raw.maxGraphReplans
  }
  if (typeof raw.maxValidatorCalls === "number" && raw.maxValidatorCalls > 0) {
    next.maxValidatorCalls = raw.maxValidatorCalls
  }
  if (typeof raw.maxNoProgressCycles === "number" && raw.maxNoProgressCycles > 0) {
    next.maxNoProgressCycles = raw.maxNoProgressCycles
  }
  if (typeof raw.maxUnitsPerGraph === "number" && raw.maxUnitsPerGraph > 0) {
    next.maxUnitsPerGraph = raw.maxUnitsPerGraph
  }
  return Object.keys(next).length ? next : undefined
}

export async function loadLongTaskCampaignSpec(specPath: string): Promise<{ spec: LongTaskCampaignSpec; specPath: string }> {
  const resolvedSpecPath = path.resolve(specPath)
  const baseDir = path.dirname(resolvedSpecPath)
  const raw = await readJsonFile<Record<string, unknown>>(resolvedSpecPath)

  const title = normalizeMaybeString(raw.title)
  const baseSpecPathRaw = normalizeMaybeString(raw.baseSpecPath)
  if (!title) {
    throw new Error(`Long-task campaign spec is missing title: ${resolvedSpecPath}`)
  }
  if (!baseSpecPathRaw) {
    throw new Error(`Long-task campaign spec is missing baseSpecPath: ${resolvedSpecPath}`)
  }

  const baseSpecPath = resolveMaybePath(baseDir, baseSpecPathRaw)
  if (!(await pathExists(baseSpecPath))) {
    throw new Error(`Long-task campaign base spec does not exist: ${baseSpecPath}`)
  }

  const rawSeedTargets = Array.isArray(raw.seedTargets) ? raw.seedTargets : []
  const seedTargets = rawSeedTargets
    .filter((item): item is Record<string, unknown> => isObject(item))
    .map((item) => {
      const targetPath = normalizeMaybeString(item.targetPath)
      const seedPath = normalizeMaybeString(item.seedPath)
      if (!targetPath || !seedPath) return undefined
      return {
        targetPath: resolveMaybePath(baseDir, targetPath),
        seedPath: resolveMaybePath(baseDir, seedPath),
        kind: item.kind === "path_copy" ? "path_copy" : "experience_workspace",
        resetOnStart: typeof item.resetOnStart === "boolean" ? item.resetOnStart : true,
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  for (const item of seedTargets) {
    if (!(await pathExists(item.seedPath))) {
      throw new Error(`Long-task campaign seed path does not exist: ${item.seedPath}`)
    }
  }

  const maxRounds =
    typeof raw.maxRounds === "number" && raw.maxRounds > 0 ? Math.floor(raw.maxRounds) : 100
  const lessonsMirror = isObject(raw.lessonsMirror)
    ? (() => {
        const workspaceTargetPath = normalizeMaybeString(raw.lessonsMirror.workspaceTargetPath)
        const relativePath = normalizeMaybeString(raw.lessonsMirror.relativePath)
        if (!workspaceTargetPath || !relativePath) return undefined
        return {
          workspaceTargetPath: resolveMaybePath(baseDir, workspaceTargetPath),
          relativePath,
          addManifestPointer:
            typeof raw.lessonsMirror.addManifestPointer === "boolean" ? raw.lessonsMirror.addManifestPointer : true,
        }
      })()
    : undefined

  const spec: LongTaskCampaignSpec = {
    title,
    baseSpecPath,
    taskFamily: normalizeMaybeString(raw.taskFamily),
    mode: raw.mode === "single_session_iterative" ? "single_session_iterative" : "graph_iterative",
    maxRounds,
    seedTargets,
    lessonsMirror,
    carryover: normalizeCarryover(raw.carryover),
    roundBudgetOverrides: normalizeBudgets(raw.roundBudgetOverrides),
    notes: normalizeMaybeString(raw.notes),
  }

  return { spec, specPath: resolvedSpecPath }
}
