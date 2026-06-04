export function hasConcreteAnswerLeakageSurface(statement: string) {
  const text = statement.replace(/\s+/g, " ").trim()
  if (!text) return false
  const numberPattern = String.raw`[-+]?\d[\d,]*(?:\.\d+)?%?`
  const answerContainer = new RegExp(
    String.raw`\b(expected|official|hidden|validated|locked|correct|final|ground[-_ ]?truth|gold)\s+answer\b.{0,80}${numberPattern}`,
    "i",
  )
  if (answerContainer.test(text)) return true
  if (new RegExp(String.raw`\banswer\b\s*(?:is|=|:)\s*["']?${numberPattern}`, "i").test(text)) return true
  if (new RegExp(String.raw`\brequired\b.{0,60}\bvalue\b.{0,60}${numberPattern}`, "i").test(text)) return true
  if (new RegExp(String.raw`\b(final|correct|validated|expected)\b.{0,40}${numberPattern}`, "i").test(text)) {
    return true
  }
  return false
}
