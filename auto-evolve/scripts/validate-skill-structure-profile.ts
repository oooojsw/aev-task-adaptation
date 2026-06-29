import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"

type JsonObject = Record<string, unknown>

interface SkillStructureFileRule {
  path: string
  required?: boolean
  kind?: "markdown" | "json" | "text" | "script" | "any"
  requiredHeadings?: string[]
  requiredKeys?: string[]
  allowEmpty?: boolean
}

interface SkillStructureProfile {
  id?: string
  rootRoles?: string[]
  rootLabels?: string[]
  rootPaths?: string[]
  closedWorld?: boolean
  allowedGlobs?: string[]
  requiredDirs?: string[]
  files?: SkillStructureFileRule[]
  maxDepth?: number
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeRelative(input: string) {
  return normalizeSlash(input).replace(/^\.\//, "").replace(/\/+/g, "/").replace(/^\/+/, "")
}

function readJson(pathValue: string) {
  return readFile(pathValue, "utf8").then((raw) => JSON.parse(raw.replace(/^\uFEFF/, "")) as JsonObject)
}

function isObject(input: unknown): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function stringList(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function parseArgs(argv: string[]) {
  const [, , payloadPath, ...rest] = argv
  let profilePath: string | undefined
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--profile") {
      profilePath = rest[i + 1]
      i += 1
    }
  }
  return { payloadPath, profilePath }
}

async function exists(pathValue: string) {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

async function isDirectory(pathValue: string) {
  try {
    return (await stat(pathValue)).isDirectory()
  } catch {
    return false
  }
}

function resolveRoots(payload: JsonObject, profile: SkillStructureProfile, profileDir: string) {
  const rootRoles = profile.rootRoles?.length ? profile.rootRoles : ["experience-workspace"]
  const rootLabels = profile.rootLabels ?? []
  const roots: string[] = []

  for (const rawPath of profile.rootPaths ?? []) {
    if (!rawPath.trim()) continue
    roots.push(path.isAbsolute(rawPath) ? rawPath : path.resolve(profileDir, rawPath))
  }

  const targetPaths = Array.isArray(payload.targetPaths) ? payload.targetPaths : []
  for (const item of targetPaths) {
    if (!isObject(item)) continue
    const rawPath = typeof item.path === "string" ? item.path : undefined
    if (!rawPath?.trim()) continue
    const role = typeof item.role === "string" ? item.role : undefined
    const label = typeof item.label === "string" ? item.label : undefined
    if ((role && rootRoles.includes(role)) || (label && rootLabels.includes(label))) {
      roots.push(path.resolve(rawPath))
    }
  }

  return Array.from(new Set(roots.map((item) => path.resolve(item))))
}

async function collectFiles(root: string, current = root, depth = 0, maxDepth = 8): Promise<string[]> {
  if (depth > maxDepth) return []
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, absolute, depth + 1, maxDepth)))
      continue
    }
    if (!entry.isFile()) continue
    out.push(normalizeRelative(path.relative(root, absolute)))
  }
  return out.sort((left, right) => left.localeCompare(right))
}

function globToRegExp(glob: string) {
  const normalized = normalizeRelative(glob)
  let source = "^"
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    const next = normalized[i + 1]
    if (char === "*" && next === "*") {
      source += ".*"
      i += 1
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  source += "$"
  return new RegExp(source)
}

function matchesAnyGlob(relativePath: string, globs: string[]) {
  const normalized = normalizeRelative(relativePath)
  return globs.some((glob) => globToRegExp(glob).test(normalized))
}

function detectKind(relativePath: string) {
  const ext = path.posix.extname(normalizeRelative(relativePath)).toLowerCase()
  if (ext === ".md") return "markdown"
  if (ext === ".json" || ext === ".jsonl") return "json"
  if (ext === ".txt" || ext === ".yaml" || ext === ".yml" || ext === ".toml") return "text"
  if ([".py", ".ps1", ".sh", ".js", ".mjs", ".cjs", ".ts"].includes(ext)) return "script"
  return "any"
}

function hasRequiredHeading(text: string, heading: string) {
  const wanted = heading.trim()
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === wanted)
}

function hasJsonKey(root: unknown, keyPath: string) {
  const parts = keyPath.split(".").map((item) => item.trim()).filter(Boolean)
  let current: unknown = root
  for (const part of parts) {
    if (!isObject(current) || !(part in current)) return false
    current = current[part]
  }
  return true
}

async function validateFileRule(root: string, rule: SkillStructureFileRule) {
  const details: string[] = []
  const rel = normalizeRelative(rule.path)
  const absolute = path.join(root, ...rel.split("/"))
  const required = rule.required !== false
  const present = await exists(absolute)
  if (!present) {
    if (required) details.push(`missing required file: ${rel}`)
    return details
  }
  if (await isDirectory(absolute)) {
    details.push(`expected file but found directory: ${rel}`)
    return details
  }

  const expectedKind = rule.kind ?? detectKind(rel)
  const actualKind = detectKind(rel)
  if (expectedKind !== "any" && actualKind !== expectedKind) {
    details.push(`file kind mismatch: ${rel} expected=${expectedKind} actual=${actualKind}`)
  }

  const raw = await readFile(absolute, "utf8").catch(() => "")
  if (rule.allowEmpty !== true && raw.trim().length === 0) {
    details.push(`file is empty: ${rel}`)
  }

  if (expectedKind === "markdown") {
    for (const heading of rule.requiredHeadings ?? []) {
      if (!hasRequiredHeading(raw, heading)) {
        details.push(`missing required heading: ${rel} -> ${heading}`)
      }
    }
  }

  if (expectedKind === "json") {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ""))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      details.push(`invalid JSON file: ${rel} (${message})`)
      return details
    }
    for (const key of rule.requiredKeys ?? []) {
      if (!hasJsonKey(parsed, key)) {
        details.push(`missing required JSON key: ${rel} -> ${key}`)
      }
    }
  }

  return details
}

async function validateRoot(root: string, profile: SkillStructureProfile) {
  const details: string[] = []
  if (!(await isDirectory(root))) {
    return {
      scannedFiles: 0,
      details: [`skill root does not exist or is not a directory: ${root}`],
    }
  }

  const files = await collectFiles(root, root, 0, profile.maxDepth ?? 8)
  for (const dir of profile.requiredDirs ?? []) {
    const rel = normalizeRelative(dir)
    if (!(await isDirectory(path.join(root, ...rel.split("/"))))) {
      details.push(`missing required directory: ${rel}`)
    }
  }

  for (const rule of profile.files ?? []) {
    details.push(...(await validateFileRule(root, rule)))
  }

  if (profile.closedWorld === true) {
    const explicitFilePaths = (profile.files ?? []).map((rule) => normalizeRelative(rule.path))
    const allowedGlobs = [...explicitFilePaths, ...(profile.allowedGlobs ?? [])]
    for (const file of files) {
      if (!matchesAnyGlob(file, allowedGlobs)) {
        details.push(`file not allowed by skill structure profile: ${file}`)
      }
    }
  }

  return { scannedFiles: files.length, details }
}

function print(result: Record<string, unknown>, exitCode: number) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(exitCode)
}

async function main() {
  const { payloadPath, profilePath } = parseArgs(Bun.argv)
  if (!payloadPath || !profilePath) {
    print(
      {
        passed: false,
        summary: "Missing validator input path or --profile path.",
        details: ["Usage: bun run validate-skill-structure-profile.ts <validator-input.json> --profile <profile.json>"],
        blocking: true,
      },
      1,
    )
  }

  const payload = await readJson(path.resolve(payloadPath))
  const resolvedProfile = path.resolve(profilePath)
  const profile = (await readJson(resolvedProfile)) as SkillStructureProfile
  const roots = resolveRoots(payload, profile, path.dirname(resolvedProfile))
  if (!roots.length) {
    print(
      {
        passed: false,
        summary: "No skill roots were resolved for structure validation.",
        details: ["Expected targetPaths with role experience-workspace, or profile.rootPaths."],
        blocking: true,
      },
      1,
    )
  }

  const rootResults = await Promise.all(roots.map((root) => validateRoot(root, profile)))
  const details = rootResults.flatMap((result, index) => [
    `root[${index}]: ${roots[index]}`,
    `scanned_files=${result.scannedFiles}`,
    ...result.details,
  ])
  const failures = rootResults.flatMap((result) => result.details)
  const passed = failures.length === 0
  print(
    {
      passed,
      summary: passed
        ? `Skill structure profile ${profile.id ?? path.basename(resolvedProfile)} passed.`
        : `Skill structure profile ${profile.id ?? path.basename(resolvedProfile)} failed.`,
      details: passed ? details.concat("no structure violations detected") : details,
      blocking: !passed,
      profileID: profile.id,
      roots,
    },
    passed ? 0 : 1,
  )
}

if (import.meta.main && !process.execArgv.includes("--check")) {
  await main()
}
