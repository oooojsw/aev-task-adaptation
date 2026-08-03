import path from "node:path"
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"

const root = process.env.DOCX_FORMAT_FIXTURE_ROOT ?? "C:/Users/ZhuanZ/Desktop/新建文件夹 (4)"
const source = path.join(root, "0708-区域联合基金申报书.docx")
const reference = path.join(root, "0313-地区科学基金项目-正文-2026-3(1).docx")
const gold = path.join(root, "0708-区域联合基金申报书-v13.docx")
const outDir = path.resolve("auto-evolve/.tmp-smoke/docx-format-product")
const oracleDir = path.join(outDir, "private-answers", "docx-format-0708")
const workspace = path.join(outDir, "workspace")
const candidate = path.join(workspace, "candidate.docx")
const badCandidate = path.join(workspace, "bad-original.docx")
const marginOnlyCandidate = path.join(workspace, "bad-margin-only.docx")
const payloadPath = path.join(outDir, "validator_input.json")
const badPayloadPath = path.join(outDir, "validator_input_bad.json")
const marginOnlyPayloadPath = path.join(outDir, "validator_input_margin_only.json")
const patchMarginsScript = path.join(outDir, "patch_margins_only.py")

async function exists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: path.resolve("."), encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)
  }
  return result.stdout
}

async function main() {
  for (const filePath of [source, reference, gold]) {
    if (!(await exists(filePath))) {
      console.log(`SKIP smoke-docx-format-product-validator: fixture missing ${filePath}`)
      return
    }
  }
  await rm(outDir, { recursive: true, force: true })
  await mkdir(oracleDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  run("python", [
    "auto-evolve/scripts/materialize-docx-format-oracle.py",
    "--source",
    source,
    "--format-reference",
    reference,
    "--gold",
    gold,
    "--out-dir",
    oracleDir,
  ])
  await copyFile(gold, candidate)
  await copyFile(source, badCandidate)
  await copyFile(source, marginOnlyCandidate)
  await writeFile(
    patchMarginsScript,
    String.raw`
import sys, zipfile, tempfile, shutil
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
ET.register_namespace("w", NS["w"])

target = Path(sys.argv[1])
gold = Path(sys.argv[2])

def read_xml(docx, name):
    with zipfile.ZipFile(docx) as zf:
        return ET.fromstring(zf.read(name))

gold_root = read_xml(gold, "word/document.xml")
gold_mar = gold_root.find(".//w:pgMar", NS)
if gold_mar is None:
    raise SystemExit("gold has no pgMar")

tmp = Path(tempfile.mkdtemp())
try:
    with zipfile.ZipFile(target) as zf:
        zf.extractall(tmp)
    doc_path = tmp / "word" / "document.xml"
    root = ET.fromstring(doc_path.read_bytes())
    mar = root.find(".//w:pgMar", NS)
    if mar is None:
        raise SystemExit("target has no pgMar")
    mar.attrib.clear()
    mar.attrib.update(gold_mar.attrib)
    doc_path.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    rebuilt = target.with_suffix(".rebuilt.docx")
    with zipfile.ZipFile(rebuilt, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in tmp.rglob("*"):
            if file.is_file():
                zf.write(file, file.relative_to(tmp).as_posix())
    rebuilt.replace(target)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`,
    "utf8",
  )
  run("python", [patchMarginsScript, marginOnlyCandidate, gold])
  await writeFile(path.join(workspace, "audit.json"), JSON.stringify({ output_docx: "candidate.docx" }, null, 2), "utf8")
  await writeFile(
    payloadPath,
    JSON.stringify(
      {
        targetPaths: [{ path: candidate, role: "answer", label: "candidate-docx" }],
      },
      null,
      2,
    ),
    "utf8",
  )
  await writeFile(
    badPayloadPath,
    JSON.stringify(
      {
        targetPaths: [{ path: badCandidate, role: "answer", label: "candidate-docx" }],
      },
      null,
      2,
    ),
    "utf8",
  )
  await writeFile(
    marginOnlyPayloadPath,
    JSON.stringify(
      {
        targetPaths: [{ path: marginOnlyCandidate, role: "answer", label: "candidate-docx" }],
      },
      null,
      2,
    ),
    "utf8",
  )
  const stdout = run("python", [
    "auto-evolve/scripts/validate-docx-format-product.py",
    payloadPath,
    "--oracle",
    path.join(oracleDir, "oracle.json"),
  ])
  const parsed = JSON.parse(stdout)
  if (parsed.passed !== true) throw new Error(`expected product validator to pass, got: ${stdout}`)
  const badStdout = run("python", [
    "auto-evolve/scripts/validate-docx-format-product.py",
    badPayloadPath,
    "--oracle",
    path.join(oracleDir, "oracle.json"),
  ])
  const badParsed = JSON.parse(badStdout)
  if (badParsed.passed !== false) throw new Error(`expected original source candidate to fail, got: ${badStdout}`)
  const marginOnlyStdout = run("python", [
    "auto-evolve/scripts/validate-docx-format-product.py",
    marginOnlyPayloadPath,
    "--oracle",
    path.join(oracleDir, "oracle.json"),
  ])
  const marginOnlyParsed = JSON.parse(marginOnlyStdout)
  if (marginOnlyParsed.passed !== false) {
    throw new Error(`expected margin-only candidate to fail typography/style gate, got: ${marginOnlyStdout}`)
  }
  const marginOnlyDetails = Array.isArray(marginOnlyParsed.details) ? marginOnlyParsed.details.join("\n") : ""
  if (!/formatting|style|font|paragraph/.test(marginOnlyDetails)) {
    throw new Error(`expected margin-only failure to mention formatting/style/font/paragraph, got: ${marginOnlyStdout}`)
  }
  console.log("smoke-docx-format-product-validator passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
