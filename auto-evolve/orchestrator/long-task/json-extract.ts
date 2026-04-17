function normalizeRawText(raw: string) {
  return raw.replace(/^\uFEFF/, "").trim()
}

function tryParseObject(candidate: string) {
  const trimmed = normalizeRawText(candidate)
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

function collectBalancedJsonObjects(raw: string) {
  const results: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "{") {
      if (depth === 0) start = index
      depth += 1
      continue
    }

    if (char === "}" && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        results.push(raw.slice(start, index + 1))
        start = -1
      }
    }
  }

  return results
}

function scoreCandidate(candidate: Record<string, unknown>, preferredKeys: string[]) {
  let score = 0
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) score += 1
  }
  return score
}

export function extractJsonObject(
  raw: string,
  options?: {
    preferredKeys?: string[]
  },
) {
  const trimmed = normalizeRawText(raw)
  if (!trimmed) return undefined

  const candidates: string[] = [trimmed]
  const fencedMatches = trimmed.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)
  for (const match of fencedMatches) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }
  candidates.push(...collectBalancedJsonObjects(trimmed))

  const uniqueCandidates = Array.from(new Set(candidates.map((item) => normalizeRawText(item)).filter(Boolean)))
  const parsedCandidates = uniqueCandidates
    .map((candidate) => ({
      candidate,
      parsed: tryParseObject(candidate),
    }))
    .filter((item): item is { candidate: string; parsed: Record<string, unknown> } => Boolean(item.parsed))

  if (!parsedCandidates.length) return undefined
  if (!options?.preferredKeys?.length) return parsedCandidates[0].parsed

  parsedCandidates.sort((left, right) => {
    const rightScore = scoreCandidate(right.parsed, options.preferredKeys ?? [])
    const leftScore = scoreCandidate(left.parsed, options.preferredKeys ?? [])
    if (rightScore !== leftScore) return rightScore - leftScore
    return left.candidate.length - right.candidate.length
  })

  return parsedCandidates[0].parsed
}
