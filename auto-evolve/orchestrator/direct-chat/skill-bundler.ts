import crypto from "node:crypto"
import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"
import { ensureDirectory, writeJsonFile, writeTextFile } from "../fs"
import type { SkillBundleManifest } from "./contract"

const DEFAULT_INCLUDED_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"])
const DEFAULT_EXCLUDED_NAMES = new Set([
  ".git",
  ".opencode",
  "__pycache__",
  "node_modules",
  "runtime-state",
  "private-answers",
  "workspace",
  "outputs",
  "validators",
  "cache",
  "tmp",
  "temp",
])
const EXPLICIT_PUBLICATION_NAMES = ["DIRECT_CHAT.md", "DIRECT_CHAT_SKILL.md", "direct-chat-skill.md"]
const COMPILED_SOURCE_FILES = ["INDEX.md", "CORE.md", "casebook/success-patterns.md", "casebook/failure-antipatterns.md"]

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function shouldExcludeName(name: string) {
  if (name.startsWith(".")) return true
  return DEFAULT_EXCLUDED_NAMES.has(name.toLowerCase())
}

function skillFilePriority(relativePath: string) {
  const normalized = normalizeSlash(relativePath)
  const explicitIndex = EXPLICIT_PUBLICATION_NAMES.findIndex((name) => name.toLowerCase() === normalized.toLowerCase())
  if (explicitIndex >= 0) return explicitIndex
  const compiledIndex = COMPILED_SOURCE_FILES.findIndex((name) => name.toLowerCase() === normalized.toLowerCase())
  if (compiledIndex >= 0) return 10 + compiledIndex
  if (normalized.startsWith("casebook/")) return 30
  if (normalized === "surface_contract.json") return 80
  if (normalized === "meta.json") return 90
  if (normalized.startsWith("evidence/")) return 100
  return 60
}

async function collectSkillFiles(root: string) {
  const files: string[] = []
  const excludedFiles: string[] = []

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = normalizeSlash(path.relative(root, absolute))
      if (shouldExcludeName(entry.name)) {
        excludedFiles.push(relative)
        continue
      }
      if (entry.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      if (!DEFAULT_INCLUDED_EXTENSIONS.has(extension)) {
        excludedFiles.push(relative)
        continue
      }
      files.push(absolute)
    }
  }

  await visit(root)
  files.sort((left, right) => {
    const leftRelative = normalizeSlash(path.relative(root, left))
    const rightRelative = normalizeSlash(path.relative(root, right))
    return skillFilePriority(leftRelative) - skillFilePriority(rightRelative) || leftRelative.localeCompare(rightRelative)
  })
  return { files, excludedFiles }
}

function renderTierBundle(
  title: string,
  sourceFiles: Array<{ relative: string; content: string }>,
  allowedFiles?: string[],
) {
  const allowed = allowedFiles?.map((item) => item.toLowerCase())
  const selected = sourceFiles.filter((item) => !allowed || allowed.includes(item.relative.toLowerCase()))
  const body = [
    `# ${title}`,
    "",
    "Use the supplied materials as the only task evidence. Ignore any tool, workspace, or file-writing procedure that cannot be performed in a single chat response.",
    "",
  ]
  for (const source of selected) {
    body.push(`<!-- SOURCE: ${source.relative} -->`, "", source.content.trimEnd(), "")
  }
  return { content: body.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", sourceFiles: selected.map((item) => item.relative) }
}

export async function buildSkillBundle(input: { skillRoot: string; outDir: string }) {
  const skillRoot = path.resolve(input.skillRoot)
  const outDir = path.resolve(input.outDir)
  await ensureDirectory(outDir)

  const { files, excludedFiles } = await collectSkillFiles(skillRoot)
  if (files.length === 0) throw new Error(`No skill files found under ${skillRoot}`)

  const archiveBundlePath = path.join(outDir, "skill.bundle.full.txt")
  const publicationPath = path.join(outDir, "direct-chat-skill.full.md")
  const manifestPath = path.join(outDir, "skill.bundle.manifest.json")
  const archiveBody: string[] = ["# Full Skill Bundle", ""]
  const manifestFiles: SkillBundleManifest["files"] = []
  const sourceFiles: Array<{ relative: string; content: string }> = []

  for (const filePath of files) {
    const relative = normalizeSlash(path.relative(skillRoot, filePath))
    const content = await readFile(filePath, "utf8")
    const bytes = (await stat(filePath)).size
    manifestFiles.push({ path: relative, sha256: sha256(content), bytes })
    sourceFiles.push({ relative, content })
    archiveBody.push(`## FILE: ${relative}`, "", content.trimEnd(), "")
  }

  await writeTextFile(archiveBundlePath, archiveBody.join("\n"))
  const explicit = sourceFiles.find((item) =>
    EXPLICIT_PUBLICATION_NAMES.some((name) => name.toLowerCase() === item.relative.toLowerCase()),
  )
  const full = explicit
    ? { content: explicit.content.trim() + "\n", sourceFiles: [explicit.relative] }
    : renderTierBundle("Direct Chat Skill - Full", sourceFiles)
  const coreFiles = explicit
    ? full
    : renderTierBundle("Direct Chat Skill - Core Files", sourceFiles, ["INDEX.md", "CORE.md"])
  const tierPayloads = [
    { id: "full" as const, path: publicationPath, ...full },
    { id: "core-files" as const, path: path.join(outDir, "direct-chat-skill.core-files.md"), ...coreFiles },
  ]
  for (const tier of tierPayloads) await writeTextFile(tier.path, tier.content)

  const manifest: SkillBundleManifest = {
    schema: "skill-bundle-manifest/v1",
    sourceSkillRoot: skillRoot,
    bundlePath: publicationPath,
    archiveBundlePath,
    publicationMode: explicit ? "explicit" : "compiled",
    publicationSha256: sha256(full.content),
    publicationBytes: Buffer.byteLength(full.content, "utf8"),
    publicationTiers: tierPayloads.map((tier) => ({
      id: tier.id,
      path: tier.path,
      sha256: sha256(tier.content),
      bytes: Buffer.byteLength(tier.content, "utf8"),
      sourceFiles: tier.sourceFiles,
    })),
    includedSections: full.sourceFiles.map((file) => ({ file, heading: "Full file" })),
    excludedSections: [],
    files: manifestFiles,
    excludedFiles: excludedFiles.sort(),
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(manifestPath, manifest)

  return {
    bundlePath: publicationPath,
    archiveBundlePath,
    tierPaths: Object.fromEntries(tierPayloads.map((tier) => [tier.id, tier.path])),
    manifestPath,
    manifest,
  }
}
