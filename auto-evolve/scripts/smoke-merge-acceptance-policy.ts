import assert from "node:assert/strict"
import {
  mergeAcceptanceRunsFinalReplay,
  mergeAcceptanceRunsReplay,
  mergeAcceptanceRunsRepair,
  mergeAcceptanceUsesStrictGate,
  normalizeMergeAcceptancePreset,
  normalizeMergeAcceptanceProfiles,
  resolveMergeAcceptanceProfile,
  normalizeMergeAcceptanceStages,
  normalizeMergeAcceptanceSuccessCriterion,
  stagesForMergeAcceptancePreset,
} from "../orchestrator/multi-instance/merge-acceptance-policy"

function eq(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label)
}

eq(stagesForMergeAcceptancePreset("merge_only"), [], "merge_only should not run replay")
eq(stagesForMergeAcceptancePreset("replay_report"), ["initial_replay"], "replay_report maps to initial replay")
eq(
  stagesForMergeAcceptancePreset("repair_promote"),
  ["initial_replay", "repair_promote"],
  "repair_promote preserves the legacy replay-plus-single-repair behavior",
)
eq(
  stagesForMergeAcceptancePreset("final_replay"),
  ["initial_replay", "repair_promote", "final_full_replay"],
  "final_replay adds a second full replay after repair",
)
eq(
  stagesForMergeAcceptancePreset("strict_all_pass"),
  ["initial_replay", "repair_promote", "final_full_replay", "strict_acceptance_gate"],
  "strict_all_pass includes all acceptance stages",
)

const strictFromAlias = normalizeMergeAcceptanceStages({ raw: "strict", preset: "merge_only" })
assert.equal(mergeAcceptanceRunsReplay(strictFromAlias), true, "strict alias must include replay dependency")
assert.equal(mergeAcceptanceRunsFinalReplay(strictFromAlias), true, "strict alias must include final replay")
assert.equal(mergeAcceptanceUsesStrictGate(strictFromAlias), true, "strict alias must include strict gate")

const finalOnly = normalizeMergeAcceptanceStages({ raw: "final_replay", preset: "merge_only" })
eq(finalOnly, ["initial_replay", "final_full_replay"], "final replay requires initial replay but not repair")
assert.equal(mergeAcceptanceRunsRepair(finalOnly), false, "final replay can be used without repair")

assert.equal(normalizeMergeAcceptancePreset("strict"), "strict_all_pass")
assert.equal(normalizeMergeAcceptanceSuccessCriterion("partial"), "allow_partial")

const profiles = normalizeMergeAcceptanceProfiles(
  {
    quick: {
      description: "Only merge for quick smoke.",
      preset: "merge_only",
      successCriterion: "report_only",
    },
    strictish: {
      preset: "strict_all_pass",
      successCriterion: "all_pass",
    },
  },
  {
    repair_promote: {
      description: "Legacy default.",
      preset: "repair_promote",
      successCriterion: "all_pass",
    },
  },
)

const defaultProfile = resolveMergeAcceptanceProfile({
  profiles,
  defaultProfile: "repair_promote",
  legacyPreset: "merge_only",
  legacySuccessCriterion: "report_only",
})
assert.equal(defaultProfile.profileName, "repair_promote")
eq(defaultProfile.stages, ["initial_replay", "repair_promote"], "default profile should resolve legacy behavior")
assert.equal(defaultProfile.source, "config-default-profile")

const cliProfile = resolveMergeAcceptanceProfile({
  profiles,
  defaultProfile: "repair_promote",
  requestedProfile: "quick",
  legacyPreset: "repair_promote",
  legacySuccessCriterion: "all_pass",
})
assert.equal(cliProfile.profileName, "quick")
eq(cliProfile.stages, [], "merge_only profile should not run replay")
assert.equal(cliProfile.successCriterion, "report_only")
assert.equal(cliProfile.source, "cli-profile")

console.log("smoke-merge-acceptance-policy: ok")
