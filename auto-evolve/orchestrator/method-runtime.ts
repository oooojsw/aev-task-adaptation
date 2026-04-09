import type { MethodFlow, MethodFlowStep } from "./methods"
import type { MethodPrimitiveOp } from "./primitives"

export type MethodRuntimeDecision = "continue" | "next_attempt" | "finish_run"

export interface MethodRuntimeStepResult {
  decision?: MethodRuntimeDecision
}

export interface MethodRuntimeTraceEntry {
  op: MethodPrimitiveOp
  decision: MethodRuntimeDecision
}

export type MethodRuntimeHandlers<TContext> = {
  [K in MethodPrimitiveOp]: (context: TContext, step: MethodFlowStep) => Promise<MethodRuntimeStepResult | void>
}

export interface MethodRuntimeResult {
  decision: Exclude<MethodRuntimeDecision, "continue"> | null
  trace: MethodRuntimeTraceEntry[]
}

export async function executeMethodFlow<TContext>(
  flow: MethodFlow,
  context: TContext,
  handlers: MethodRuntimeHandlers<TContext>,
) {
  const trace: MethodRuntimeTraceEntry[] = []

  for (const step of flow.steps) {
    const handler = handlers[step.op]
    if (!handler) {
      throw new Error(`No handler registered for method op: ${step.op}`)
    }

    const result = await handler(context, step)
    const decision = result?.decision ?? "continue"
    trace.push({ op: step.op, decision })

    if (decision === "next_attempt" || decision === "finish_run") {
      return {
        decision,
        trace,
      } satisfies MethodRuntimeResult
    }
  }

  return {
    decision: null,
    trace,
  } satisfies MethodRuntimeResult
}
