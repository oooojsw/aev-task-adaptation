export interface SafePreviewOptions {
  maxArrayItems?: number
  maxObjectKeys?: number
  maxDepth?: number
  maxStringChars?: number
}

const DEFAULT_OPTIONS: Required<SafePreviewOptions> = {
  maxArrayItems: 3,
  maxObjectKeys: 6,
  maxDepth: 3,
  maxStringChars: 1200,
}

function truncateString(value: string, maxChars: number) {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}... (${value.length - maxChars} more chars omitted)`
}

function previewValue(
  value: unknown,
  options: Required<SafePreviewOptions>,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === undefined) return "[undefined]"
  if (value === null) return null

  if (typeof value === "string") return truncateString(value, options.maxStringChars)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return `${value.toString()}n`
  if (typeof value === "symbol") return String(value)
  if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`

  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message, options.maxStringChars),
      stack: value.stack ? truncateString(value.stack, options.maxStringChars) : undefined,
    }
  }

  if (depth >= options.maxDepth) {
    if (Array.isArray(value)) return `[Array(${value.length}) omitted at depth ${depth}]`
    const keys = Object.keys(value as Record<string, unknown>)
    return `[Object(${keys.length} keys) omitted at depth ${depth}]`
  }

  if (seen.has(value as object)) return "[Circular]"
  seen.add(value as object)

  if (Array.isArray(value)) {
    const sample = value
      .slice(0, options.maxArrayItems)
      .map((item) => previewValue(item, options, depth + 1, seen))
    const output: Record<string, unknown> = {
      __type: "Array",
      length: value.length,
    }
    if (value.length > options.maxArrayItems) output.__omittedItems = value.length - options.maxArrayItems
    output.sample = sample
    return output
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const output: Record<string, unknown> = {}
  if (keys.length > options.maxObjectKeys) {
    output.__omittedKeys = `${keys.length - options.maxObjectKeys} more keys omitted`
  }
  for (const key of keys.slice(0, options.maxObjectKeys)) {
    output[key] = previewValue(record[key], options, depth + 1, seen)
  }
  return output
}

export function safePreview(value: unknown, options: SafePreviewOptions = {}) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value !== "object") return String(value)

  const merged = { ...DEFAULT_OPTIONS, ...options }
  try {
    return JSON.stringify(previewValue(value, merged, 0, new WeakSet()), null, 2)
  } catch {
    return String(value)
  }
}

export function hasPreviewableContent(value: unknown) {
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return true
  if (Array.isArray(value)) return value.length > 0
  if (value instanceof Error) return Boolean(value.message || value.stack)
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0
  return String(value).trim().length > 0
}
