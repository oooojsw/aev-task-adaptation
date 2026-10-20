import type { Plan } from "../plan"
import { explorationPolicy, explorationIdentity, type ExplorationPolicy } from "./policy"
import { validateExplorationPolicyV2, type ExplorationPolicyV2 } from "./policy-v2"
import { fingerprint } from "../../protocol-plugins/identity"

export type AnyExplorationPolicy = ExplorationPolicy | ExplorationPolicyV2

export function readExplorationPolicy(
  value: unknown,
  plan: Readonly<Plan>,
): Readonly<AnyExplorationPolicy> | undefined {
  if (value === undefined) return undefined
  if (value === null) {
    throw new Error("Invalid exploration policy: explicit null not allowed")
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid exploration policy: expected object")
  }
  const schema = (value as { schema?: unknown }).schema
  if (schema === "aev.exploration-policy.v1") {
    return explorationPolicy(value, plan)
  }
  if (schema === "aev.exploration-policy.v2") {
    return validateExplorationPolicyV2(value, plan)
  }
  throw new Error(`Unsupported exploration policy schema: ${String(schema)}`)
}

export function explorationIdentityAny(value: unknown, plan: Readonly<Plan>): string | undefined {
  if (value === undefined) return undefined
  const policy = readExplorationPolicy(value, plan)
  if (!policy) return undefined
  if (policy.schema === "aev.exploration-policy.v1") {
    return explorationIdentity(policy, plan)
  }
  return fingerprint({ plan: fingerprint(plan), policy })
}
