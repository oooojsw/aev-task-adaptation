export type PacketizationPolicyID = "single-case-packet" | "batch-5-aggregate"

export interface PacketizationPolicyDescriptor {
  id: PacketizationPolicyID
  title: string
  summary: string
  kind: "single_case" | "batch_aggregate"
  defaultBatchSize: number
  reusableInLayer3: boolean
}

const PACKETIZATION_POLICIES = new Map<PacketizationPolicyID, PacketizationPolicyDescriptor>([
  [
    "single-case-packet",
    {
      id: "single-case-packet",
      title: "Single-Case Packet",
      summary: "Turn one case run into one maintenance request without cross-case aggregation.",
      kind: "single_case",
      defaultBatchSize: 1,
      reusableInLayer3: true,
    },
  ],
  [
    "batch-5-aggregate",
    {
      id: "batch-5-aggregate",
      title: "Batch-5 Aggregate",
      summary: "Aggregate up to five shard learning records into one batch learning packet for one maintainer.",
      kind: "batch_aggregate",
      defaultBatchSize: 5,
      reusableInLayer3: true,
    },
  ],
])

export function resolvePacketizationPolicy(policyID: PacketizationPolicyID): PacketizationPolicyDescriptor {
  const policy = PACKETIZATION_POLICIES.get(policyID)
  if (!policy) {
    throw new Error(`Unknown packetization policy: ${policyID}`)
  }
  return policy
}

