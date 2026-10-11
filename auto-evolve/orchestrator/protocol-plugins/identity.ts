import { createHash } from "node:crypto"
import type { Json } from "./contract"

export function canonical(value: unknown): string {
  const seen = new Set<object>()
  function visit(item: unknown): Json {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number" && Number.isFinite(item)) return item
    if (typeof item !== "object" || !item) throw new Error("Protocol values must be finite JSON")
    if (seen.has(item)) throw new Error("Cyclic protocol value")
    seen.add(item)
    try {
      if (Array.isArray(item)) return item.map(visit)
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error("Protocol values must be plain objects")
      }
      const result: Record<string, Json> = Object.create(null)
      for (const key of Object.keys(item).sort()) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe protocol key")
        result[key] = visit((item as Record<string, unknown>)[key])
      }
      return result
    } finally {
      seen.delete(item)
    }
  }
  return JSON.stringify(visit(value))
}

export function fingerprint(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

export function immutable<T>(value: T): T {
  const copy: T = JSON.parse(canonical(value))
  function freeze(item: unknown) {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(copy)
  return copy
}
