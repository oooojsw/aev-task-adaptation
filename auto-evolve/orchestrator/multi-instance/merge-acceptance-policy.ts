export type MergeAcceptanceStage =
  | "initial_replay"
  | "repair_promote"
  | "final_full_replay"
  | "strict_acceptance_gate"

export type MergeAcceptancePreset =
  | "merge_only"
  | "replay_report"
  | "repair_promote"
  | "final_replay"
  | "strict_all_pass"

export type MergeAcceptanceSuccessCriterion = "all_pass" | "allow_partial" | "report_only"

export interface MergeAcceptanceProfile {
  description?: string
  preset: MergeAcceptancePreset
  stages?: MergeAcceptanceStage[]
  successCriterion: MergeAcceptanceSuccessCriterion
}

export interface ResolvedMergeAcceptanceProfile {
  profileName: string
  description?: string
  preset: MergeAcceptancePreset
  stages: MergeAcceptanceStage[]
  successCriterion: MergeAcceptanceSuccessCriterion
  source: "cli-profile" | "config-default-profile" | "legacy-config"
}

export type MergeAcceptanceStatus =
  | "not_run"
  | "merge_only"
  | "replay_passed"
  | "replay_failed"
  | "repair_promoted"
  | "final_replay_passed"
  | "final_replay_failed"
  | "strict_success"
  | "strict_failed"

const STAGE_ORDER: MergeAcceptanceStage[] = [
  "initial_replay",
  "repair_promote",
  "final_full_replay",
  "strict_acceptance_gate",
]

const PRESET_STAGES: Record<MergeAcceptancePreset, MergeAcceptanceStage[]> = {
  merge_only: [],
  replay_report: ["initial_replay"],
  repair_promote: ["initial_replay", "repair_promote"],
  final_replay: ["initial_replay", "repair_promote", "final_full_replay"],
  strict_all_pass: ["initial_replay", "repair_promote", "final_full_replay", "strict_acceptance_gate"],
}

export function normalizeMergeAcceptancePreset(
  raw: unknown,
  fallback: MergeAcceptancePreset = "repair_promote",
): MergeAcceptancePreset {
  if (typeof raw !== "string") return fallback
  const value = raw.trim().toLowerCase().replace(/-/g, "_")
  if (
    value === "merge_only" ||
    value === "replay_report" ||
    value === "repair_promote" ||
    value === "final_replay" ||
    value === "strict_all_pass"
  ) {
    return value
  }
  if (value === "merge") return "merge_only"
  if (value === "replay") return "replay_report"
  if (value === "repair") return "repair_promote"
  if (value === "strict") return "strict_all_pass"
  return fallback
}

export function normalizeMergeAcceptanceSuccessCriterion(
  raw: unknown,
  fallback: MergeAcceptanceSuccessCriterion = "all_pass",
): MergeAcceptanceSuccessCriterion {
  if (typeof raw !== "string") return fallback
  const value = raw.trim().toLowerCase().replace(/-/g, "_")
  if (value === "all_pass" || value === "allow_partial" || value === "report_only") return value
  if (value === "all") return "all_pass"
  if (value === "partial") return "allow_partial"
  if (value === "report") return "report_only"
  return fallback
}

function normalizeOptionalDescription(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

export function normalizeMergeAcceptanceProfile(
  raw: unknown,
  fallback: MergeAcceptanceProfile = {
    preset: "repair_promote",
    successCriterion: "all_pass",
  },
): MergeAcceptanceProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback, stages: fallback.stages ? [...fallback.stages] : undefined }
  const record = raw as Record<string, unknown>
  const preset = normalizeMergeAcceptancePreset(record.preset, fallback.preset)
  const stages = record.stages === undefined ? fallback.stages : normalizeMergeAcceptanceStages({ raw: record.stages, preset })
  const successCriterion = normalizeMergeAcceptanceSuccessCriterion(record.successCriterion, fallback.successCriterion)
  return {
    description: normalizeOptionalDescription(record.description) ?? fallback.description,
    preset,
    stages: stages ? [...stages] : undefined,
    successCriterion,
  }
}

export function normalizeMergeAcceptanceProfiles(
  raw: unknown,
  fallback: Record<string, MergeAcceptanceProfile>,
): Record<string, MergeAcceptanceProfile> {
  const out: Record<string, MergeAcceptanceProfile> = {}
  for (const [key, value] of Object.entries(fallback)) {
    if (!key.trim()) continue
    out[key.trim()] = normalizeMergeAcceptanceProfile(value)
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) continue
    out[key.trim()] = normalizeMergeAcceptanceProfile(value, out[key.trim()])
  }
  return out
}

function normalizeStageName(raw: string): MergeAcceptanceStage | undefined {
  const value = raw.trim().toLowerCase().replace(/-/g, "_")
  if (
    value === "initial_replay" ||
    value === "repair_promote" ||
    value === "final_full_replay" ||
    value === "strict_acceptance_gate"
  ) {
    return value
  }
  if (value === "replay" || value === "train_replay") return "initial_replay"
  if (value === "repair" || value === "promote") return "repair_promote"
  if (value === "final_replay" || value === "full_replay") return "final_full_replay"
  if (value === "strict" || value === "gate") return "strict_acceptance_gate"
  return undefined
}

function addDependencies(stages: Set<MergeAcceptanceStage>) {
  if (
    stages.has("repair_promote") ||
    stages.has("final_full_replay") ||
    stages.has("strict_acceptance_gate")
  ) {
    stages.add("initial_replay")
  }
  if (stages.has("strict_acceptance_gate")) {
    stages.add("final_full_replay")
  }
}

export function stagesForMergeAcceptancePreset(preset: MergeAcceptancePreset): MergeAcceptanceStage[] {
  return [...PRESET_STAGES[preset]]
}

export function normalizeMergeAcceptanceStages(input: {
  raw?: unknown
  preset?: MergeAcceptancePreset
}): MergeAcceptanceStage[] {
  const preset = input.preset ?? "repair_promote"
  const source =
    typeof input.raw === "string"
      ? input.raw.split(/[,\s]+/)
      : Array.isArray(input.raw)
        ? input.raw
        : stagesForMergeAcceptancePreset(preset)

  const stages = new Set<MergeAcceptanceStage>()
  for (const item of source) {
    if (typeof item !== "string") continue
    const stage = normalizeStageName(item)
    if (stage) stages.add(stage)
  }
  addDependencies(stages)
  return STAGE_ORDER.filter((stage) => stages.has(stage))
}

export function resolveMergeAcceptanceProfile(input: {
  profiles: Record<string, MergeAcceptanceProfile>
  defaultProfile?: string
  requestedProfile?: string
  legacyPreset: MergeAcceptancePreset
  legacySuccessCriterion: MergeAcceptanceSuccessCriterion
}): ResolvedMergeAcceptanceProfile {
  const requested = input.requestedProfile?.trim()
  const defaultName = input.defaultProfile?.trim()
  const profileName =
    requested && input.profiles[requested]
      ? requested
      : defaultName && input.profiles[defaultName]
        ? defaultName
        : "legacy-config"
  const source =
    requested && input.profiles[requested]
      ? "cli-profile"
      : defaultName && input.profiles[defaultName]
        ? "config-default-profile"
        : "legacy-config"
  const profile = input.profiles[profileName]
  const preset = profile?.preset ?? input.legacyPreset
  const successCriterion = profile?.successCriterion ?? input.legacySuccessCriterion
  return {
    profileName,
    description: profile?.description,
    preset,
    stages: profile?.stages ? [...profile.stages] : stagesForMergeAcceptancePreset(preset),
    successCriterion,
    source,
  }
}

export function hasMergeAcceptanceStage(stages: MergeAcceptanceStage[], stage: MergeAcceptanceStage) {
  return stages.includes(stage)
}

export function mergeAcceptanceRunsReplay(stages: MergeAcceptanceStage[]) {
  return hasMergeAcceptanceStage(stages, "initial_replay")
}

export function mergeAcceptanceRunsRepair(stages: MergeAcceptanceStage[]) {
  return hasMergeAcceptanceStage(stages, "repair_promote")
}

export function mergeAcceptanceRunsFinalReplay(stages: MergeAcceptanceStage[]) {
  return hasMergeAcceptanceStage(stages, "final_full_replay")
}

export function mergeAcceptanceUsesStrictGate(stages: MergeAcceptanceStage[]) {
  return hasMergeAcceptanceStage(stages, "strict_acceptance_gate")
}
