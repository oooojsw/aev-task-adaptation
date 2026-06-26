import path from "node:path"
import os from "node:os"
import process from "node:process"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"

const repoRoot = path.resolve(__dirname, "..", "..")
const autoEvolveRoot = path.join(repoRoot, "auto-evolve")
const profileRoot = process.env.AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT?.trim()
  ? path.resolve(process.env.AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT)
  : path.join(autoEvolveRoot, ".opencode-private")

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function hostConfigCandidates() {
  return unique([
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json") : "",
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  ])
}

function hostAuthCandidates() {
  return unique([
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : "",
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "auth.json") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "auth.json") : "",
  ])
}

function hostModelCacheCandidates() {
  return unique([
    process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, "opencode", "models.json") : "",
    path.join(os.homedir(), ".cache", "opencode", "models.json"),
  ])
}

async function copyFirstExisting(candidates: string[], target: string, label: string) {
  await mkdir(path.dirname(target), { recursive: true })
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    await copyFile(candidate, target)
    return { label, source: candidate, target, copied: true }
  }
  return { label, source: null, target, copied: false }
}

async function sanitizeConfig(sourceCandidates: string[], target: string) {
  await mkdir(path.dirname(target), { recursive: true })
  for (const candidate of sourceCandidates) {
    if (!existsSync(candidate)) continue
    const parsed = JSON.parse((await readFile(candidate, "utf8")).replace(/^\uFEFF/, ""))
    const sanitized: Record<string, unknown> = {}
    for (const key of ["provider", "disabled_providers", "model", "small_model"] as const) {
      if (parsed?.[key] !== undefined) sanitized[key] = parsed[key]
    }
    sanitized.$schema = "https://opencode.ai/config.json"
    await writeFile(target, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8")
    return { label: "opencode.json", source: candidate, target, copied: true }
  }
  await writeFile(target, `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`, "utf8")
  return { label: "opencode.json", source: null, target, copied: false }
}

async function main() {
  const configTarget = path.join(profileRoot, "config", "opencode", "opencode.json")
  const agentsTarget = path.join(profileRoot, "config", "opencode", "AGENTS.md")
  const authTarget = path.join(profileRoot, "data", "opencode", "auth.json")
  const cacheTarget = path.join(profileRoot, "cache", "opencode", "models.json")

  const results = [
    await sanitizeConfig(hostConfigCandidates(), configTarget),
    await copyFirstExisting(hostAuthCandidates(), authTarget, "auth.json"),
    await copyFirstExisting(hostModelCacheCandidates(), cacheTarget, "models.json"),
  ]

  await mkdir(path.dirname(agentsTarget), { recursive: true })
  await writeFile(
    agentsTarget,
    [
      "# AUTO-EVOLVE PRIVATE OPENCODE PROFILE",
      "",
      "This AGENTS.md belongs only to auto-evolve isolated sessions.",
      "It is intentionally minimal and does not mirror the user's live OpenCode AGENTS.md.",
      "Follow the orchestrator prompt, task prompt, permissions, and output contract.",
      "",
    ].join("\n"),
    "utf8",
  )

  const readme = [
    "# Auto-Evolve Private OpenCode Profile",
    "",
    "This directory is a private snapshot used only by auto-evolve orchestrated OpenCode sessions.",
    "Runtime sessions must read provider/model/auth/model-cache data from here, not from the user's live OpenCode config.",
    "Do not commit this directory. It may contain API keys.",
    "",
    `Imported at: ${new Date().toISOString()}`,
    "",
    "Files:",
    "- config/opencode/opencode.json: sanitized provider/model config only.",
    "- data/opencode/auth.json: copied auth keys.",
    "- cache/opencode/models.json: copied model cache.",
    "- config/opencode/AGENTS.md: optional profile-local instructions.",
    "",
  ].join("\n")
  await writeFile(path.join(profileRoot, "README.md"), readme, "utf8")

  console.log(`Private OpenCode profile root: ${profileRoot}`)
  for (const item of results) {
    console.log(`${item.label}: ${item.copied ? "copied" : "missing"} -> ${item.target}`)
  }
  console.log(`AGENTS.md: minimal private profile -> ${agentsTarget}`)
  console.log("No secret values were printed.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
