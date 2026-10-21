import path from "node:path"
import type { LongTaskSpec } from "../long-task/contract"
import type { LongTaskCampaignWorkerRole } from "../long-task-campaign/contract"
import { compileRoleAccess } from "../task-profile-access/compiler"
import type {
  InformationViewDescriptor,
  RoleAccessPolicy,
} from "../task-profile-access/contract"

export const MULTI_SKILL_MERGE_PROFILE_ID = "multi_skill_merge_v2"

export const MULTI_SKILL_MERGE_WORKER_ROLES: LongTaskCampaignWorkerRole[] = [
  "merge_source_inventory_auditor",
  "merge_coverage_mapper",
  "merge_conflict_resolver",
  "merge_deduplication_curator",
  "merge_provenance_guard",
  "merge_replay_failure_diagnostician",
]

export function isMultiSkillMergeProfile(spec: LongTaskSpec) {
  return (
    spec.taskProfile?.id === MULTI_SKILL_MERGE_PROFILE_ID &&
    spec.taskProfile.accessSystem === "profile_v2"
  )
}

function present(items: Array<string | undefined>) {
  return items.filter((item): item is string => Boolean(item))
}

export type MultiSkillMergeAccessContext = {
  stageDir: string
  sourceRoots: string[]
  taskDefinitionPaths: string[]
  candidateReadRoot?: string
  candidateWriteRoots?: string[]
  plannerWriteRoots?: string[]
  tracePaths?: string[]
  workerSuggestionPaths?: string[]
  replayEvidencePaths?: string[]
  internalStatePaths?: string[]
  oraclePaths?: string[]
}

function commonDirectory(paths: string[], fallback: string) {
  const directories = paths.map((item) => path.dirname(path.resolve(item)))
  if (!directories.length) return path.resolve(fallback)
  let common = directories[0]!
  for (const directory of directories.slice(1)) {
    while (!isPathInside(common, directory)) {
      const parent = path.dirname(common)
      if (parent === common) return path.resolve(fallback)
      common = parent
    }
  }
  return common
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function makeViews(input: MultiSkillMergeAccessContext): InformationViewDescriptor[] {
  const taskRoot = commonDirectory(input.taskDefinitionPaths, input.stageDir)
  const sourceBoundaries = input.sourceRoots.length ? input.sourceRoots : [taskRoot]
  const tracePaths = present(input.tracePaths ?? [])
  const workerPaths = present(input.workerSuggestionPaths ?? [])
  const replayPaths = present(input.replayEvidencePaths ?? [])
  const internalPaths = present(input.internalStatePaths ?? [])
  const oraclePaths = present(input.oraclePaths ?? [])
  const candidateRead = present([input.candidateReadRoot])
  const candidateWrites = present(input.candidateWriteRoots ?? [])
  const plannerWrites = present(input.plannerWriteRoots ?? [])
  const views: InformationViewDescriptor[] = [
    {
      id: "task_definition",
      description: "Task entry, merge contract, manifests, and replay plan.",
      paths: input.taskDefinitionPaths,
      entryPaths: input.taskDefinitionPaths,
      boundaryRoots: [taskRoot],
      sensitivity: "public",
      access: "read_only",
    },
    {
      id: "source_skills",
      description: "Frozen source Skill packages and source lineage index.",
      paths: input.sourceRoots,
      entryPaths: input.sourceRoots,
      boundaryRoots: sourceBoundaries,
      sensitivity: "training",
      access: "read_only",
    },
    {
      id: "candidate_skill",
      paths: candidateRead,
      entryPaths: candidateRead,
      boundaryRoots: candidateRead.length ? candidateRead : [input.stageDir],
      sensitivity: "training",
      access: "read_only",
    },
    {
      id: "candidate_skill_next",
      paths: candidateWrites,
      entryPaths: [],
      boundaryRoots: candidateWrites.length ? candidateWrites : [input.stageDir],
      sensitivity: "training",
      access: "write_only",
    },
    {
      id: "planner_output",
      description: "The graph draft directory for this planning session.",
      paths: plannerWrites,
      entryPaths: [],
      boundaryRoots: plannerWrites.length ? plannerWrites : [input.stageDir],
      sensitivity: "internal",
      access: "write_only",
    },
    {
      id: "run_trace",
      paths: tracePaths,
      entryPaths: tracePaths,
      boundaryRoots: tracePaths.length ? tracePaths : [input.stageDir],
      sensitivity: "internal",
      access: "read_only",
    },
    {
      id: "worker_findings",
      paths: workerPaths,
      entryPaths: workerPaths,
      boundaryRoots: workerPaths.length ? workerPaths : [input.stageDir],
      sensitivity: "internal",
      access: "read_only",
    },
    {
      id: "replay_failures",
      paths: replayPaths,
      entryPaths: replayPaths,
      boundaryRoots: replayPaths.length ? replayPaths : [input.stageDir],
      sensitivity: "training",
      access: "read_only",
    },
    {
      id: "campaign_state",
      paths: internalPaths,
      entryPaths: internalPaths,
      boundaryRoots: internalPaths.length ? internalPaths : [input.stageDir],
      sensitivity: "internal",
      access: "read_only",
    },
    {
      id: "private_oracle",
      paths: oraclePaths,
      entryPaths: oraclePaths,
      boundaryRoots: oraclePaths.length ? oraclePaths : [input.stageDir],
      sensitivity: "private_oracle",
      access: "read_only",
    },
  ]
  return views.filter((view) => view.paths.length > 0)
}

function workerPolicy(role: LongTaskCampaignWorkerRole, views: InformationViewDescriptor[]): RoleAccessPolicy {
  const available = new Set(views.map((view) => view.id))
  const readable = [
    "task_definition",
    "source_skills",
    "candidate_skill",
    "run_trace",
    "replay_failures",
    "campaign_state",
    "private_oracle",
  ].filter((id) => available.has(id))
  return {
    roleID: role,
    readableViews: readable,
    writableViews: [],
    referenceViews: ["task_definition", "source_skills", "replay_failures"].filter((id) => available.has(id)),
    allowedSensitivities: ["public", "training", "internal", "private_oracle"],
    allowShell: false,
  }
}

export async function buildMultiSkillMergeRoleAccess(input: {
  role: LongTaskCampaignWorkerRole | "merge_lead" | "merge_retention_reviewer" | "merge_planner"
  context: MultiSkillMergeAccessContext
}) {
  const views = makeViews(input.context)
  const available = new Set(views.map((view) => view.id))
  let policy: RoleAccessPolicy
  if (input.role === "merge_lead") {
    policy = {
      roleID: input.role,
      readableViews: [
        "task_definition",
        "source_skills",
        "candidate_skill",
        "run_trace",
        "worker_findings",
        "replay_failures",
        "campaign_state",
        "private_oracle",
      ].filter((id) => available.has(id)),
      writableViews: ["candidate_skill_next"].filter((id) => available.has(id)),
      referenceViews: ["task_definition", "source_skills", "worker_findings", "replay_failures"].filter((id) =>
        available.has(id),
      ),
      allowedSensitivities: ["public", "training", "internal", "private_oracle"],
      allowShell: false,
    }
  } else if (input.role === "merge_retention_reviewer") {
    policy = {
      roleID: input.role,
      readableViews: [
        "task_definition",
        "source_skills",
        "candidate_skill",
        "run_trace",
        "worker_findings",
        "replay_failures",
        "campaign_state",
        "private_oracle",
      ].filter((id) => available.has(id)),
      writableViews: [],
      referenceViews: ["task_definition", "source_skills", "candidate_skill", "replay_failures"].filter((id) =>
        available.has(id),
      ),
      allowedSensitivities: ["public", "training", "internal", "private_oracle"],
      allowShell: false,
    }
  } else if (input.role === "merge_planner") {
    policy = {
      roleID: input.role,
      readableViews: ["task_definition", "source_skills", "campaign_state"].filter((id) => available.has(id)),
      writableViews: ["planner_output"].filter((id) => available.has(id)),
      referenceViews: ["task_definition", "source_skills"].filter((id) => available.has(id)),
      allowedSensitivities: ["public", "training", "internal"],
      allowShell: false,
    }
  } else {
    policy = workerPolicy(input.role, views)
  }
  return compileRoleAccess({
    profileID: MULTI_SKILL_MERGE_PROFILE_ID,
    policy,
    views,
    manifestPath: path.join(input.context.stageDir, "access-manifest.json"),
  })
}

export function buildMultiSkillMergePlannerPrompt(input: {
  basePrompt: string
  accessManifestPath: string
  planningOutputPath: string
}) {
  return [
    "You are planning a multi-Skill merge campaign, not solving one source case.",
    `Access manifest: ${input.accessManifestPath}`,
    `Required graph draft: ${input.planningOutputPath}`,
    "",
    "Read access-manifest.json first. Inspect the frozen source Skills and task definition before drafting the graph.",
    "Plan work that inventories every source, maps coverage, resolves conflicts, deduplicates guidance, preserves provenance, and diagnoses replay failures.",
    "Do not edit source Skills, candidate Skills, evidence, or campaign state.",
    "Your only writable view is planner_output.",
    "",
    input.basePrompt,
  ].join("\n")
}

const WORKER_OBJECTIVES: Partial<Record<LongTaskCampaignWorkerRole, string>> = {
  merge_source_inventory_auditor:
    "Inventory every frozen source Skill and flag unreadable, missing, duplicated, or lineage-inconsistent inputs.",
  merge_coverage_mapper:
    "Map reusable procedures, case-specific exceptions, and source-case coverage before the lead edits the candidate.",
  merge_conflict_resolver:
    "Identify contradictory instructions across source Skills and recommend a general rule plus bounded exceptions.",
  merge_deduplication_curator:
    "Find duplicated guidance and recommend canonical homes without deleting unique coverage.",
  merge_provenance_guard:
    "Check that proposed merged guidance remains traceable to source Skills and does not invent unsupported rules.",
  merge_replay_failure_diagnostician:
    "Diagnose replay failures, distinguish product mistakes from infrastructure failures, and map each repair back to leaf cases.",
}

export function buildMultiSkillMergeWorkerPrompt(input: {
  role: LongTaskCampaignWorkerRole
  roundNumber: number
  accessManifestPath: string
}) {
  return [
    "You are a read-only specialist in a multi-Skill merge campaign.",
    `Round: ${input.roundNumber}`,
    `Role: ${input.role}`,
    `Objective: ${WORKER_OBJECTIVES[input.role] ?? "Analyze merge evidence for the lead."}`,
    `Access manifest: ${input.accessManifestPath}`,
    "",
    "Read access-manifest.json first. It is the authoritative list of information views you may inspect.",
    "Do not edit source Skills, the candidate Skill, campaign state, or any evidence file.",
    "Source Skills are evidence, not a template to concatenate blindly.",
    "Never copy private answers or case-specific answer literals into package advice.",
    "Translate case evidence into general workflow guidance or a clearly bounded casebook entry.",
    "Use forward slashes in every path reference.",
    "",
    "Return your complete final analysis in ordinary text or Markdown, not JSON. Include findings, evidence, uncertainties and actionable recommendations.",
    "Exclude hidden reasoning, tool transcripts and context-compaction summaries.",
  ].join("\n")
}

export function buildMultiSkillMergeLeadPrompt(input: {
  roundNumber: number
  accessManifestPath: string
  nextCandidateRoot: string
}) {
  return [
    "You are the merge lead for a multi-Skill merge campaign.",
    `Round: ${input.roundNumber}`,
    `Access manifest: ${input.accessManifestPath}`,
    `Primary editable Skill output root: ${input.nextCandidateRoot}`,
    "",
    "Read access-manifest.json first. It is authoritative for every writable output, including campaign control artifacts.",
    "Read all worker findings and the source-skill lineage before editing.",
    "Produce a usable Skill package, not a merge report.",
    "Preserve every source capability that is still supported by evidence.",
    "Resolve conflicts with a general rule plus bounded casebook exceptions.",
    "Deduplicate repeated guidance into one canonical location with references.",
    "Repair replay failures without regressing previously passing source cases.",
    "Do not edit frozen source Skills or evidence.",
    "Do not copy private answers, hidden literals, or validator-only truth into the Skill.",
    "Use forward slashes in JSON and path references.",
    "",
    "After writing the output, return JSON only:",
    JSON.stringify(
      {
        summary: "one short sentence",
        updated_files: ["file changed under the only editable output root"],
        package_highlights: ["coverage retained or repaired"],
        tree_highlights: ["conflict, provenance, or replay decisions"],
        refs: ["source evidence path"],
        surface_precheck_passed: true,
        surface_precheck_details: ["self-check result"],
      },
      null,
      2,
    ),
  ].join("\n")
}

export function buildMultiSkillMergeReviewerPrompt(input: {
  roundNumber: number
  accessManifestPath: string
}) {
  return [
    "You are the read-only retention reviewer for a multi-Skill merge campaign.",
    `Round: ${input.roundNumber}`,
    `Access manifest: ${input.accessManifestPath}`,
    "",
    "Read access-manifest.json first.",
    "Review whether the candidate retained source coverage, resolved conflicts, avoided unsupported invention, and addressed replay failures.",
    "Do not edit any file and do not declare product correctness beyond the supplied validators.",
    "Mark not ready when unique source coverage disappeared, a conflict was hidden rather than resolved, or case-specific answers leaked.",
    "",
    "Return JSON only:",
    JSON.stringify(
      {
        ready_for_final_acceptance: false,
        summary: "one short sentence",
        reasons: ["evidence-grounded risk"],
        next_attention_areas: ["specific repair area"],
        refs: ["source or replay evidence path"],
      },
      null,
      2,
    ),
  ].join("\n")
}
