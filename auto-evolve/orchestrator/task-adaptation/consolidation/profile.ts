import type { Profile } from "../catalogue"
import { CONSOLIDATION_PROFILE_ID } from "./contract"

// An opt-in profile; host must separately bind an approved evaluator and checker.
export function consolidationProfile(entry: string, capability: string): Profile {
  if (!/^[A-Za-z][\w.-]*$/.test(entry) || !/^[A-Za-z][\w.-]*$/.test(capability)) {
    throw new Error("Invalid consolidation resource or capability ID")
  }
  return {
    id: CONSOLIDATION_PROFILE_ID,
    description: "Evolve one <=5000-character Skill using independent one-turn Direct Chat cases and trusted pass_rate scoring.",
    kinds: ["skill"],
    requires: [capability],
    acceptance: {
      execution: "script",
      checks: [
        { id: "consolidation_surface", target: "candidate", mechanism: "script", purpose: "Reject overlength and invalid Skill before model requests", required: true, resources: [entry], feedback: "message" },
        { id: "consolidation_score", target: "product", mechanism: "script", purpose: "Verify all independent Direct Chat verdicts and their immutable run identity", required: true, resources: [entry], feedback: "message" },
      ],
    },
    rejection: [
      { check: "consolidation_surface", actions: ["repair"] },
      { check: "consolidation_score", actions: ["repair"] },
    ],
    selection: { rule: "best_pass", metric: "pass_rate", direction: "max" },
  }
}
