import path from "node:path"
import { mkdir, rm, stat } from "node:fs/promises"
import { spawnSync } from "node:child_process"

const root = process.env.DOCX_FORMAT_FIXTURE_ROOT ?? "C:/Users/ZhuanZ/Desktop/新建文件夹 (4)"
const source = path.join(root, "0708-区域联合基金申报书.docx")
const reference = path.join(root, "0313-地区科学基金项目-正文-2026-3(1).docx")
const gold = path.join(root, "0708-区域联合基金申报书-v13.docx")
const outDir = path.resolve("auto-evolve/.tmp-smoke/docx-format-oracle")

async function exists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function main() {
  for (const filePath of [source, reference, gold]) {
    if (!(await exists(filePath))) {
      console.log(`SKIP smoke-docx-format-oracle: fixture missing ${filePath}`)
      return
    }
  }
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const result = spawnSync(
    "python",
    [
      "auto-evolve/scripts/materialize-docx-format-oracle.py",
      "--source",
      source,
      "--format-reference",
      reference,
      "--gold",
      gold,
      "--out-dir",
      outDir,
    ],
    { cwd: path.resolve("."), encoding: "utf8" },
  )
  if (result.status !== 0) {
    throw new Error(`oracle materializer failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)
  }
  for (const name of ["oracle.json", "source-fingerprints.json", "comments-oracle.json", "images-oracle.json"]) {
    if (!(await exists(path.join(outDir, name)))) throw new Error(`missing generated oracle file: ${name}`)
  }
  console.log("smoke-docx-format-oracle passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
