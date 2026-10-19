import { fingerprint } from "../../protocol-plugins/identity"

export interface Admission {
  schema: "aev.exploration-admission.v1"
  policy: string
  round: number
  pass: number
  generation: 0 | 1
  stage: "author" | "acceptance" | "delivery"
  roles: string[]
  calls: number
  tokens: number
  protectedCalls: number
  protectedTokens: number
}

export function admission(value: Admission) {
  if (
    !value ||
    value.schema !== "aev.exploration-admission.v1" ||
    Object.keys(value).sort().join(",") !==
      [
        "schema",
        "policy",
        "round",
        "pass",
        "generation",
        "stage",
        "roles",
        "calls",
        "tokens",
        "protectedCalls",
        "protectedTokens",
      ]
        .sort()
        .join(",") ||
    typeof value.policy !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.policy) ||
    !Number.isSafeInteger(value.round) ||
    value.round < 1 ||
    !Number.isSafeInteger(value.pass) ||
    value.pass < 1 ||
    ![0, 1].includes(value.generation) ||
    !["author", "acceptance", "delivery"].includes(value.stage) ||
    !Array.isArray(value.roles) ||
    !value.roles.length ||
    value.roles.some((item) => typeof item !== "string" || !item.trim()) ||
    new Set(value.roles).size !== value.roles.length ||
    [value.calls, value.tokens, value.protectedCalls, value.protectedTokens].some(
      (item) => !Number.isSafeInteger(item) || item < 0,
    ) ||
    (value.calls === 0) !== (value.tokens === 0) ||
    (value.protectedCalls === 0) !== (value.protectedTokens === 0)
  )
    throw new Error("Invalid finite exploration admission")
  return { id: fingerprint(value), policy: structuredClone(value) }
}

export function nextAdmission(previous: Admission, next: Admission) {
  if (
    previous.policy !== next.policy ||
    previous.stage === "delivery" ||
    next.round < previous.round ||
    next.generation < previous.generation ||
    next.generation > previous.generation + 1 ||
    (next.stage === "delivery"
      ? next.generation !== previous.generation || next.round !== previous.round || next.pass !== previous.pass
      : previous.stage === "author"
        ? next.stage !== "acceptance" ||
          next.round !== previous.round ||
          next.pass !== previous.pass ||
          next.generation !== previous.generation
        : next.stage !== "author" ||
          (next.round === previous.round
            ? next.pass !== previous.pass + 1 || next.generation !== previous.generation
            : next.round !== previous.round + 1 || next.pass !== 1))
  )
    throw new Error("Invalid exploration admission transition")
}
