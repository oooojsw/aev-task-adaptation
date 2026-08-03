import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"

const outDir = path.resolve("auto-evolve/.tmp-smoke/docx-format-surface")
const cleanRoot = path.join(outDir, "clean-skill")
const leakRoot = path.join(outDir, "leak-skill")
const runtimeRoot = path.join(outDir, "runtime-state", "long-task-campaigns", "case", "validation-expert-workspace")
const profilePath = path.join(outDir, "profile.json")
const zeroScanProfilePath = path.join(outDir, "profile-zero-scan.json")

function run(payloadPath: string, selectedProfilePath = profilePath) {
  const result = spawnSync(
    process.execPath,
    ["run", "auto-evolve/scripts/validate-docx-format-surface-generalization.ts", payloadPath, "--profile", selectedProfilePath],
    { cwd: path.resolve("."), encoding: "utf8" },
  )
  if (result.status !== 0) {
    throw new Error(`surface validator crashed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(cleanRoot, { recursive: true })
  await mkdir(leakRoot, { recursive: true })
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(
    path.join(cleanRoot, "CORE.md"),
    [
      "# DOCX formatting process",
      "Use the source document as content owner.",
      "Use the format reference only for margins, typography, and paragraph style.",
      "Preserve comments, images, headings, and protected tail sections.",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    path.join(leakRoot, "CORE.md"),
    [
      "# Bad leak",
      "Open C:/Users/ZhuanZ/Desktop/新建文件夹 (4)/0708-区域联合基金申报书-v13.docx and copy the result.",
      "This was fixed in round-003 of the DOCX format transfer 0708 campaign.",
      "删除第 120 到 180 段。",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    path.join(runtimeRoot, "CORE.md"),
    [
      "# Runtime-root clean skill",
      "Use reusable DOCX style transfer steps only.",
      "Do not copy reference content.",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    profilePath,
    JSON.stringify(
      {
        rootRoles: ["experience-workspace"],
        maxDepth: 4,
        ignorePathSubstrings: ["/runtime-state/", "/node_modules/"],
        forbiddenLiterals: ["0708", "0313", "docx-format-0708"],
        forbiddenPathSubstrings: ["private-answers", "runtime-state", "validator_input.json"],
        forbiddenPatterns: ["C:[\\\\/][^\\n\\r<>]+", "round\\s*[-_]?\\s*\\d+", "campaign"],
      },
      null,
      2,
    ),
    "utf8",
  )
  await writeFile(
    zeroScanProfilePath,
    JSON.stringify({ rootRoles: ["experience-workspace"], allowedExtensions: [".nope"] }, null, 2),
    "utf8",
  )
  const cleanPayload = path.join(outDir, "payload-clean.json")
  const leakPayload = path.join(outDir, "payload-leak.json")
  const runtimePayload = path.join(outDir, "payload-runtime.json")
  await writeFile(cleanPayload, JSON.stringify({ targetPaths: [{ path: cleanRoot, role: "experience-workspace" }] }, null, 2), "utf8")
  await writeFile(leakPayload, JSON.stringify({ targetPaths: [{ path: leakRoot, role: "experience-workspace" }] }, null, 2), "utf8")
  await writeFile(runtimePayload, JSON.stringify({ targetPaths: [{ path: runtimeRoot, role: "experience-workspace" }] }, null, 2), "utf8")
  const clean = run(cleanPayload)
  const leak = run(leakPayload)
  const runtime = run(runtimePayload)
  const zeroScan = run(cleanPayload, zeroScanProfilePath)
  if (clean.passed !== true) throw new Error(`expected clean skill to pass, got ${JSON.stringify(clean)}`)
  if (leak.passed !== false) throw new Error(`expected leaking skill to fail, got ${JSON.stringify(leak)}`)
  if (runtime.passed !== true) throw new Error(`expected runtime-state root clean skill to pass, got ${JSON.stringify(runtime)}`)
  if (zeroScan.passed !== false) throw new Error(`expected zero scanned files to fail closed, got ${JSON.stringify(zeroScan)}`)
  console.log("smoke-docx-format-surface-validator passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
