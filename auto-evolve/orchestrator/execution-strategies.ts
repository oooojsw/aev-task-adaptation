export type ExecutionStrategyID = "sequential" | "parallel-batch-5-light-shard"

export interface ExecutionStrategyDescriptor {
  id: ExecutionStrategyID
  title: string
  summary: string
  kind: "single_case" | "parallel_batch"
  defaultBatchSize: number
  lightShard: boolean
  reusableInLayer3: boolean
}

const EXECUTION_STRATEGIES = new Map<ExecutionStrategyID, ExecutionStrategyDescriptor>([
  [
    "sequential",
    {
      id: "sequential",
      title: "Sequential Execution",
      summary: "Process one case at a time and let accepted maintenance update the active workspace immediately.",
      kind: "single_case",
      defaultBatchSize: 1,
      lightShard: false,
      reusableInLayer3: true,
    },
  ],
  [
    "parallel-batch-5-light-shard",
    {
      id: "parallel-batch-5-light-shard",
      title: "Parallel Batch-5 Light Shard",
      summary:
        "Run up to five light shards in parallel from one frozen batch base, then synthesize one batch-level maintenance transaction.",
      kind: "parallel_batch",
      defaultBatchSize: 5,
      lightShard: true,
      reusableInLayer3: true,
    },
  ],
])

export function resolveExecutionStrategy(strategyID: ExecutionStrategyID): ExecutionStrategyDescriptor {
  const strategy = EXECUTION_STRATEGIES.get(strategyID)
  if (!strategy) {
    throw new Error(`Unknown execution strategy: ${strategyID}`)
  }
  return strategy
}

export function isParallelBatchExecutionStrategy(strategyID: ExecutionStrategyID) {
  return resolveExecutionStrategy(strategyID).kind === "parallel_batch"
}

