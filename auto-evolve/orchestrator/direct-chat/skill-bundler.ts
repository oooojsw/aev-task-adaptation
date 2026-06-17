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

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function shouldExcludeName(name: string) {
  if (name.startsWith(".")) return true
  return DEFAULT_EXCLUDED_NAMES.has(name.toLowerCase())
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
  return { files, excludedFiles }
}

export async function buildSkillBundle(input: { skillRoot: string; outDir: string }) {
  const skillRoot = path.resolve(input.skillRoot)
  const outDir = path.resolve(input.outDir)
  await ensureDirectory(outDir)

  const { files, excludedFiles } = await collectSkillFiles(skillRoot)
  if (files.length === 0) throw new Error(`No skill files found under ${skillRoot}`)

  const bundlePath = path.join(outDir, "skill.bundle.txt")
  const manifestPath = path.join(outDir, "skill.bundle.manifest.json")
  const body: string[] = ["# Skill Bundle", ""]
  const manifestFiles: SkillBundleManifest["files"] = []

  for (const filePath of files) {
    const relative = normalizeSlash(path.relative(skillRoot, filePath))
    const content = await readFile(filePath, "utf8")
    const bytes = (await stat(filePath)).size
    const sha256 = crypto.createHash("sha256").update(content).digest("hex")
    manifestFiles.push({ path: relative, sha256, bytes })
    body.push(`## FILE: ${relative}`, "", content.trimEnd(), "")
  }

  await writeTextFile(bundlePath, body.join("\n"))
  const manifest: SkillBundleManifest = {
    schema: "skill-bundle-manifest/v1",
    sourceSkillRoot: skillRoot,
    bundlePath,
    files: manifestFiles,
    excludedFiles: excludedFiles.sort(),
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(manifestPath, manifest)

  return { bundlePath, manifestPath, manifest }
}
