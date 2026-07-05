import path from "node:path"
import { cp, lstat, rm } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile, readTextFile, writeTextFile } from "../orchestrator/fs"
import {
  experienceWorkspacePathsFromRoot,
  readExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
} from "../orchestrator/experience-workspace"

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function uniqueStrings(input: string[]) {
  return Array.from(new Set(input.map((item) => item.trim()).filter(Boolean)))
}

function declaredPaths(contract: Record<string, unknown> | undefined) {
  if (!contract) return []
  const out: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== "string") return
    const normalized = normalizeSlash(value).replace(/^\.\//, "").replace(/\/+/g, "/").trim()
    if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return
    out.push(normalized)
  }
  add(contract.entry)
  add(contract.changeLog)
  for (const item of Array.isArray(contract.documents) ? contract.documents : []) {
    if (typeof item === "string") add(item)
    else if (item && typeof item === "object") add((item as Record<string, unknown>).path)
  }
  return uniqueStrings(out)
}

async function ensureParent(target: string) {
  await ensureDirectory(path.dirname(target))
}

async function copyRequired(sourceRoot: string, targetRoot: string) {
  const contractPath = path.join(sourceRoot, "surface_contract.json")
  const contract = await readJsonFile<Record<string, unknown>>(contractPath)
  for (const relative of declaredPaths(contract)) {
    const source = path.join(sourceRoot, ...relative.split("/"))
    const target = path.join(targetRoot, ...relative.split("/"))
    if (await pathExists(target)) continue
    if (!(await pathExists(source))) continue
    const stats = await lstat(source)
    if (stats.isDirectory()) await cp(source, target, { recursive: true, force: true })
    else {
      await ensureParent(target)
      await cp(source, target, { force: true })
    }
  }
}

async function main() {
  const root = path.resolve("auto-evolve", ".tmp-smoke", "campaign-surface-contract-copy")
  const source = path.join(root, "source")
  const target = path.join(root, "target")
  await rm(root, { recursive: true, force: true })
  await ensureDirectory(path.join(source, "casebook"))
  await writeTextFile(path.join(source, "INDEX.md"), "# Index\n")
  await writeTextFile(path.join(source, "CORE.md"), "# Core\n")
  await writeTextFile(path.join(source, "meta.json"), JSON.stringify({ ok: true }, null, 2))
  await writeTextFile(path.join(source, "casebook", "README.md"), "# Casebook\n")
  await writeTextFile(
    path.join(source, "surface_contract.json"),
    JSON.stringify({ version: 1, entry: "INDEX.md", documents: ["INDEX.md", "CORE.md", "meta.json", "casebook/"] }, null, 2),
  )

  const snapshot = await readExperienceWorkspace(experienceWorkspacePathsFromRoot(source, "manifest.md"))
  await ensureDirectory(target)
  await writeExperienceWorkspaceSnapshot(target, snapshot)
  if (await pathExists(path.join(target, "meta.json"))) {
    throw new Error("Smoke setup invalid: meta.json should be filtered by the workspace snapshot before contract repair.")
  }
  await copyRequired(source, target)
  if (!(await pathExists(path.join(target, "meta.json")))) {
    throw new Error("surface_contract required file was not copied: meta.json")
  }
  const meta = await readTextFile(path.join(target, "meta.json"))
  if (!meta.includes('"ok": true')) throw new Error("copied meta.json content mismatch")
  console.log(JSON.stringify({ ok: true, copied: ["meta.json"] }))
}

await main()
