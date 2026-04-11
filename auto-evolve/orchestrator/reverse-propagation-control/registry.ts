import type {
  ReversePropagationComponentCategory,
  ReversePropagationComponentDescriptor,
  ReversePropagationMaintenanceModuleDescriptor,
  ReversePropagationStateChannelDescriptor,
} from "./contract"

const COMPONENTS: ReversePropagationComponentDescriptor[] = [
  {
    id: "direct-rewrite",
    title: "Direct Rewrite",
    summary:
      "Directly revise the current tracked experience workspace into a better canonical version.",
    category: "maintenance_module",
    layer: 2,
    status: "active",
    stateful: false,
    pluginFriendly: true,
    defaultLoadingStrategyID: "full-workspace-read-via-entry",
    defaultScopeLevelID: "full-access",
  },
  {
    id: "add-only-memory",
    title: "Add-Only Memory",
    summary:
      "Preserve existing expert memory and prefer additive lessons, guides, notes, and narrow helper assets.",
    category: "maintenance_module",
    layer: 2,
    status: "active",
    stateful: false,
    pluginFriendly: true,
    defaultLoadingStrategyID: "full-workspace-read-via-entry",
    defaultScopeLevelID: "full-access",
    defaultOperationIDs: [
      "inspect_workspace",
      "inspect_templates",
      "inspect_failure_context",
      "inspect_session_records",
      "append_to_existing_module",
      "create_module",
      "create_helper_asset",
      "update_helper_asset",
      "add_tool_guide",
      "add_failure_lesson",
      "rewrite_entry_navigation",
      "record_change",
    ],
  },
  {
    id: "no-extra-constraint",
    title: "No Extra Constraint",
    summary:
      "Run the selected maintenance module without an additional cross-round constraint overlay.",
    category: "constraint_policy",
    layer: "cross_layer",
    status: "active",
    stateful: false,
    pluginFriendly: true,
  },
  {
    id: "text-learning-rate",
    title: "Text Learning Rate",
    summary:
      "Limit how much text may change in one maintenance round so the system learns in smaller, safer steps.",
    category: "constraint_policy",
    layer: "cross_layer",
    status: "planned",
    stateful: true,
    pluginFriendly: false,
    notes: ["This depends on cross-round change tracking and budget-aware acceptance checks."],
  },
  {
    id: "maintenance-momentum",
    title: "Maintenance Momentum",
    summary:
      "Bias the next maintenance round with evidence from previous rounds so the optimization direction has memory.",
    category: "constraint_policy",
    layer: "cross_layer",
    status: "planned",
    stateful: true,
    pluginFriendly: false,
    notes: ["This needs explicit state channels such as maintenance_round_history."],
  },
  {
    id: "default-judge-routing",
    title: "Default Judge Routing",
    summary:
      "Use current judge outputs and routing hints to decide which workspace targets and session records matter most.",
    category: "routing_policy",
    layer: 2,
    status: "active",
    stateful: true,
    pluginFriendly: true,
  },
  {
    id: "batch-aggregate-routing",
    title: "Batch Aggregate Routing",
    summary:
      "Group a small shard batch into one learning packet before invoking a single maintainer.",
    category: "routing_policy",
    layer: 2,
    status: "active",
    stateful: true,
    pluginFriendly: true,
  },
  {
    id: "error-to-edit",
    title: "Error-to-Edit",
    summary:
      "Translate failure evidence directly into edit pressure on the most relevant expert-memory surface.",
    category: "routing_policy",
    layer: 2,
    status: "planned",
    stateful: true,
    pluginFriendly: false,
  },
  {
    id: "dual-axis-bp",
    title: "Dual-Axis BP",
    summary:
      "Assign failure pressure separately to rules and tools so the system can tell logic mistakes from infrastructure mistakes.",
    category: "routing_policy",
    layer: 2,
    status: "planned",
    stateful: true,
    pluginFriendly: false,
  },
  {
    id: "strict-regression-guard",
    title: "Strict Regression Guard",
    summary:
      "Reject and roll back a maintenance attempt when the current case remains broken or regression evidence worsens.",
    category: "acceptance_policy",
    layer: 2,
    status: "active",
    stateful: true,
    pluginFriendly: true,
  },
  {
    id: "add-only-conservative-guard",
    title: "Add-Only Conservative Guard",
    summary:
      "Accept only narrow additive maintenance that fixes the current case without hurting old behavior.",
    category: "acceptance_policy",
    layer: 2,
    status: "active",
    stateful: true,
    pluginFriendly: true,
  },
  {
    id: "single-branch-governance",
    title: "Single-Branch Governance",
    summary:
      "Run one propagation campaign from one source ref to one candidate branch result without merge or promotion logic.",
    category: "governance_strategy",
    layer: 3,
    status: "active",
    stateful: true,
    pluginFriendly: true,
  },
  {
    id: "branch-preserving",
    title: "Branch Preserving Governance",
    summary: "Keep multiple candidate branches alive for later comparison instead of overwriting one active branch.",
    category: "governance_strategy",
    layer: 3,
    status: "planned",
    stateful: true,
    pluginFriendly: false,
  },
  {
    id: "merge-compare-promotion",
    title: "Merge Compare Promotion",
    summary:
      "Compare candidate branches, optionally merge them, and promote a winning version into canonical.",
    category: "governance_strategy",
    layer: 3,
    status: "planned",
    stateful: true,
    pluginFriendly: false,
  },
  {
    id: "experience-compression",
    title: "Experience Compression",
    summary:
      "Rewrite or reorganize expert experience into a more compact and general form while preserving behavior.",
    category: "optimization_strategy",
    layer: 4,
    status: "planned",
    stateful: true,
    pluginFriendly: false,
  },
  {
    id: "adversarial-suite-builder",
    title: "Adversarial Suite Builder",
    summary:
      "Generate challenge suites that attack the current expert memory to expose brittle boundaries and overfitting.",
    category: "optimization_strategy",
    layer: 4,
    status: "planned",
    stateful: true,
    pluginFriendly: false,
  },
  {
    id: "sensory-augmentation-suite",
    title: "Sensory Augmentation Suite",
    summary:
      "Generate semantically equivalent but noisier or reformatted inputs to test whether expert memory is overfitting surface form.",
    category: "optimization_strategy",
    layer: 4,
    status: "planned",
    stateful: true,
    pluginFriendly: false,
  },
]

const STATE_CHANNELS: ReversePropagationStateChannelDescriptor[] = [
  {
    id: "maintenance_round_history",
    title: "Maintenance Round History",
    summary:
      "Carries prior maintenance rounds, rollback reasons, and narrowing feedback into later maintenance attempts.",
    producers: ["strict-regression-guard", "add-only-conservative-guard"],
    consumers: ["maintenance-momentum", "direct-rewrite", "add-only-memory"],
  },
  {
    id: "judge_routing_signal",
    title: "Judge Routing Signal",
    summary:
      "Carries judge classifications, suggested workspace targets, and selected session records into maintenance.",
    producers: ["default-judge-routing", "batch-aggregate-routing"],
    consumers: ["direct-rewrite", "add-only-memory", "dual-axis-bp"],
  },
  {
    id: "regression_evidence",
    title: "Regression Evidence",
    summary:
      "Carries before/after regression pass counts and explicit regression losses into post-judge acceptance.",
    producers: ["strict-regression-guard", "add-only-conservative-guard"],
    consumers: ["text-learning-rate", "maintenance-momentum"],
  },
  {
    id: "campaign_lineage",
    title: "Campaign Lineage",
    summary:
      "Carries source refs, candidate commits, and branch history across propagation campaigns.",
    producers: ["single-branch-governance"],
    consumers: ["branch-preserving", "merge-compare-promotion"],
  },
  {
    id: "optimizer_memory",
    title: "Optimizer Memory",
    summary:
      "Carries fourth-layer learning about what kinds of global optimizations helped or harmed generalization.",
    producers: ["experience-compression", "adversarial-suite-builder", "sensory-augmentation-suite"],
    consumers: ["experience-compression", "adversarial-suite-builder", "sensory-augmentation-suite"],
  },
]

function isMaintenanceModule(
  component: ReversePropagationComponentDescriptor,
): component is ReversePropagationMaintenanceModuleDescriptor {
  return component.category === "maintenance_module"
}

export function listReversePropagationComponents(category?: ReversePropagationComponentCategory) {
  return category ? COMPONENTS.filter((item) => item.category === category) : [...COMPONENTS]
}

export function resolveReversePropagationComponent(componentID: string) {
  const component = COMPONENTS.find((item) => item.id === componentID)
  if (!component) {
    throw new Error(`Unknown reverse-propagation component: ${componentID}`)
  }
  return component
}

export function listRegisteredMaintenanceModules() {
  return COMPONENTS.filter(isMaintenanceModule)
}

export function resolveRegisteredMaintenanceModule(moduleID?: string) {
  const target = moduleID ?? "direct-rewrite"
  const found = COMPONENTS.find((item) => item.id === target)
  if (found && isMaintenanceModule(found)) return found
  throw new Error(`Unknown maintenance module: ${target}`)
}

export function listReversePropagationStateChannels() {
  return [...STATE_CHANNELS]
}
