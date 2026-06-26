import path from "node:path"
import { writeJsonFile } from "../fs"
import type {
  ValidationModuleDescriptor,
  ValidationResult,
  ValidationResultViewKind,
  ValidationResultViews,
} from "./contract"

const PRIVATE_PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s"'`]*private-answers[^\s"'`]*|(?:^|[\\/])private-answers[\\/][^\s"'`]*|\bprivate-answers[\\/][^\s"'`]*)/gi
const ANSWER_LITERAL_PATTERN = /([-+]?\d[\d,]*(?:\.\d+)?%?)/g

function redactText(input: string, mode: "training" | "sanitized") {
  // Always redact private answer paths in any non-private view.
  let text = input.replace(PRIVATE_PATH_PATTERN, "<PRIVATE_ANSWER_PATH>")
  if (mode === "training") {
    return text
  }
  text = text.replace(ANSWER_LITERAL_PATTERN, "<NUMERIC_LITERAL>")
  text = text.replace(/(["'`]).{0,160}\1/g, "<QUOTED_SNIPPET>")
  return text
}

function redactValue(value: unknown, mode: "training" | "sanitized"): unknown {
  if (typeof value === "string") return redactText(value, mode)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, mode))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value)) {
      const lower = key.toLowerCase()

      // sanitized strips raw / stdout / stderr entirely.
      if (mode === "sanitized" && (lower.includes("stdout") || lower.includes("stderr") || lower.includes("raw"))) {
        continue
      }

      // sanitized strongly redacts answer/ground/private field values.
      if (mode === "sanitized" && (lower.includes("answer") || lower.includes("ground") || lower.includes("private"))) {
        out[key] = "<REDACTED>"
        continue
      }

      // training preserves answer/ground/private field VALUES (open-book oracle).
      // Private paths inside string values are still redacted by redactText().
      out[key] = redactValue(raw, mode)
    }
    return out
  }
  return value
}

export function buildValidationResultViews(input: {
  descriptor: ValidationModuleDescriptor
  result: ValidationResult
  raw?: Record<string, unknown>
}): ValidationResultViews {
  const common = {
    validatorID: input.result.validatorID,
    title: input.descriptor.title,
    target: input.descriptor.target,
    mechanism: input.descriptor.mechanism,
    stage: input.descriptor.stage,
    passed: input.result.passed,
    blocking: input.result.blocking,
    summary: input.result.summary,
    details: input.result.details,
    evidenceRefs: input.result.evidenceRefs,
    rawOutputPath: input.result.rawOutputPath,
    raw: input.raw ?? {},
  }
  const training = redactValue(common, "training") as Record<string, unknown>
  const sanitized = redactValue(
    {
      validatorID: input.result.validatorID,
      title: input.descriptor.title,
      target: input.descriptor.target,
      mechanism: input.descriptor.mechanism,
      stage: input.descriptor.stage,
      passed: input.result.passed,
      blocking: input.result.blocking,
      summary: input.result.summary,
      detailCount: input.result.details.length,
      evidenceCount: input.result.evidenceRefs.length,
    },
    "sanitized",
  ) as Record<string, unknown>
  return {
    private: common,
    training,
    sanitized,
    score_only: {
      validatorID: input.result.validatorID,
      stage: input.descriptor.stage,
      passed: input.result.passed,
      score: input.result.passed ? 1 : 0,
      blocking: input.result.blocking,
    },
  }
}

export async function writeValidationResultViews(input: {
  dir: string
  views: ValidationResultViews
  kinds?: ValidationResultViewKind[]
}) {
  const kinds = input.kinds ?? (Object.keys(input.views) as ValidationResultViewKind[])
  const paths: Partial<Record<ValidationResultViewKind, string>> = {}
  for (const kind of kinds) {
    const out = path.join(input.dir, `result.${kind}.json`)
    await writeJsonFile(out, input.views[kind])
    paths[kind] = out
  }
  return paths
}
