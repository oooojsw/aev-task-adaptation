import path from "node:path"
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"

type CliOptions = {
  taskPackRoot: string
  split: string
  outDir: string
  splitName: "train" | "val" | "test"
  skillRoot?: string
  skillOut?: string
  buildLocalTextCorpus: boolean
  docsOut?: string
  corpusMode: "page-window" | "full"
  ocrPython: string
  ocrHelper: string
  ocrUmiExe: string
  ocrPageWindow: number
}

function parseArgs(argv: string[]): CliOptions {
  const options: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) options[key] = "true"
    else {
      options[key] = value
      index += 1
    }
  }
  const taskPackRoot = options["task-pack-root"]
  const split = options.split
  const outDir = options["out-dir"]
  if (!taskPackRoot || !split || !outDir) {
    throw new Error(
      [
        "Usage:",
        "bun run auto-evolve/scripts/export-officeqa-skillopt-bridge.ts",
        "  --task-pack-root <officeqa task pack>",
        "  --split <split json>",
        "  --out-dir <bridge output dir>",
        "  [--split-name test|train|val]",
        "  [--skill-root <skill directory>]",
        "  [--skill-out <merged skill md>]",
        "  [--build-local-text-corpus]",
        "  [--docs-out <SkillOpt docs root; defaults to <out-dir>/docs>]",
        "  [--corpus-mode page-window|full]",
        "  [--ocr-python python]",
        "  [--ocr-helper auto-evolve/scripts/direct-chat-local-ocr.py]",
        "  [--ocr-umi-exe <PaddleOCR-json.exe>]",
        "  [--ocr-page-window 4]",
      ].join("\n"),
    )
  }
  const splitName = (options["split-name"] || "test") as CliOptions["splitName"]
  if (!["train", "val", "test"].includes(splitName)) throw new Error(`Invalid --split-name: ${splitName}`)
  const corpusMode = (options["corpus-mode"] || "page-window") as CliOptions["corpusMode"]
  if (!["page-window", "full"].includes(corpusMode)) throw new Error(`Invalid --corpus-mode: ${corpusMode}`)
  return {
    taskPackRoot: path.resolve(taskPackRoot),
    split: path.resolve(split),
    outDir: path.resolve(outDir),
    splitName,
    skillRoot: options["skill-root"] ? path.resolve(options["skill-root"]) : undefined,
    skillOut: options["skill-out"] ? path.resolve(options["skill-out"]) : undefined,
    buildLocalTextCorpus: options["build-local-text-corpus"] === "true",
    docsOut: options["docs-out"] ? path.resolve(options["docs-out"]) : undefined,
    corpusMode,
    ocrPython: options["ocr-python"] || "python",
    ocrHelper: options["ocr-helper"]
      ? path.resolve(options["ocr-helper"])
      : path.resolve(import.meta.dir, "direct-chat-local-ocr.py"),
    ocrUmiExe:
      options["ocr-umi-exe"] ||
      "E:/project/Umi-OCR_Paddle_v2.1.5/UmiOCR-data/plugins/win7_x64_PaddleOCR-json/PaddleOCR-json.exe",
    ocrPageWindow: Math.max(0, Number.parseInt(options["ocr-page-window"] || "4", 10) || 4),
  }
}

async function readText(filePath: string) {
  return (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "")
}

function extractSectionLines(text: string, heading: string) {
  const lines = text.split(/\r?\n/g)
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase())
  if (start < 0) return []
  const collected: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^[A-Z][A-Za-z ]+:$/.test(line.trim())) break
    if (!line.trim()) {
      if (collected.length) break
      continue
    }
    collected.push(line)
  }
  return collected
}

function extractQuestion(instruction: string) {
  const match = instruction.match(/Question:\s*([\s\S]*?)(?:\r?\n\r?\nDifficulty:|\r?\nDifficulty:)/i)
  if (match) return match[1]!.trim()
  const fallback = instruction.match(/Question:\s*([\s\S]*)/i)
  return (fallback?.[1] || instruction).trim()
}

function extractDifficulty(instruction: string) {
  const match = instruction.match(/Difficulty:\s*([^\r\n]+)/i)
  return (match?.[1] || "officeqa").trim()
}

function extractSourceDocs(instruction: string) {
  return extractSectionLines(instruction, "Source document URLs:")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
}

function extractPageHint(sourceDoc: string) {
  const match = sourceDoc.match(/[?&]page=(\d+)/i)
  if (!match) return undefined
  const value = Number.parseInt(match[1]!, 10)
  return Number.isFinite(value) ? value : undefined
}

function extractLocalPdfNames(instruction: string, spec: any) {
  const fromInstruction = extractSectionLines(instruction, "Local source PDFs:")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
  const fromSpec = Array.isArray(spec?.materials)
    ? spec.materials
        .map((material: any) => String(material?.path || ""))
        .filter((entry: string) => entry.toLowerCase().endsWith(".pdf"))
    : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of [...fromInstruction, ...fromSpec]) {
    const filename = path.basename(raw).replace(/\.pdf$/i, ".txt")
    if (!filename || seen.has(filename)) continue
    seen.add(filename)
    result.push(filename)
  }
  return result
}

function extractLocalPdfPaths(taskRoot: string, instruction: string, spec: any) {
  const fromInstruction = extractSectionLines(instruction, "Local source PDFs:")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
  const fromSpec = Array.isArray(spec?.materials)
    ? spec.materials
        .map((material: any) => String(material?.path || ""))
        .filter((entry: string) => entry.toLowerCase().endsWith(".pdf"))
    : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of [...fromInstruction, ...fromSpec]) {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(taskRoot, raw)
    if (!resolved.toLowerCase().endsWith(".pdf") || seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }
  return result
}

async function loadSplitIDs(splitPath: string) {
  const payload = JSON.parse(await readText(splitPath))
  if (Array.isArray(payload)) return payload.map((item) => String(item))
  if (Array.isArray(payload?.ids)) return payload.ids.map((item: unknown) => String(item))
  if (Array.isArray(payload?.items)) {
    return payload.items.map((item: any) => String(typeof item === "string" ? item : item.id || item.uid)).filter(Boolean)
  }
  throw new Error(`Unsupported split format: ${splitPath}`)
}

async function loadOfficeQAItem(taskPackRoot: string, uid: string) {
  const taskRoot = path.join(taskPackRoot, "tasks", uid)
  const instructionPath = path.join(taskRoot, "instruction.md")
  const specPath = path.join(taskRoot, "spec.json")
  const answerPath = path.join(taskPackRoot, "private-answers", uid, "answer.txt")
  const instruction = await readText(instructionPath)
  const spec = JSON.parse(await readText(specPath))
  const groundTruth = (await readText(answerPath)).trim()
  const sourceDocs = extractSourceDocs(instruction)
  return {
    id: uid,
    uid,
    question: extractQuestion(instruction),
    ground_truth: groundTruth,
    answers: groundTruth ? [groundTruth] : [],
    task_type: "officeqa",
    category: extractDifficulty(instruction),
    source_files: extractLocalPdfNames(instruction, spec),
    source_docs: sourceDocs,
    source_pdf_paths: extractLocalPdfPaths(taskRoot, instruction, spec),
    page_hints: sourceDocs.map(extractPageHint).filter((value) => typeof value === "number"),
    source_split: "auto-evolve-bridge",
  }
}

async function writeSplitDir(options: CliOptions) {
  const ids = await loadSplitIDs(options.split)
  const splitRoot = path.join(options.outDir, "split")
  for (const name of ["train", "val", "test"]) {
    await mkdir(path.join(splitRoot, name), { recursive: true })
    await writeFile(path.join(splitRoot, name, "items.json"), "[]\n", "utf8")
  }
  const items = []
  for (const uid of ids) items.push(await loadOfficeQAItem(options.taskPackRoot, uid))
  await writeFile(path.join(splitRoot, options.splitName, "items.json"), JSON.stringify(items, null, 2) + "\n", "utf8")
  await writeFile(
    path.join(splitRoot, "split_manifest.json"),
    JSON.stringify(
      {
        schema: "auto-evolve-skillopt-officeqa-bridge/v1",
        sourceTaskPackRoot: options.taskPackRoot,
        sourceSplit: options.split,
        splitName: options.splitName,
        itemCount: items.length,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  return { splitRoot, items }
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function runProcess(command: string, args: string[]) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }))
  })
}

async function runOcrHelper(input: { options: CliOptions; pdfPath: string; rawOut: string; pageHint?: number }) {
  const args = [
    input.options.ocrHelper,
    "--input",
    input.pdfPath,
    "--output",
    input.rawOut,
    "--umi-exe",
    input.options.ocrUmiExe,
  ]
  if (typeof input.pageHint === "number") {
    args.push("--page-hint", String(input.pageHint), "--page-window", String(input.options.ocrPageWindow))
  }
  const result = await runProcess(input.options.ocrPython, args)
  if (result.exitCode !== 0) {
    throw new Error(`OCR failed for ${input.pdfPath}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`)
  }
  return JSON.parse(await readText(input.rawOut)) as { text?: string; pages?: Array<{ page: number; lineCount: number }> }
}

function uniqueSortedNumbers(values: unknown[]) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b)
}

async function writeLocalTextCorpus(options: CliOptions, items: Array<Record<string, any>>) {
  if (!options.buildLocalTextCorpus) return undefined
  const docsRoot = options.docsOut || path.join(options.outDir, "docs")
  const transformedRoot = path.join(docsRoot, "transformed")
  const rawRoot = path.join(docsRoot, "raw-ocr")
  await mkdir(transformedRoot, { recursive: true })
  await mkdir(rawRoot, { recursive: true })

  const byPdf = new Map<string, { sourceFile: string; pageHints: number[] }>()
  for (const item of items) {
    const sourceFiles = Array.isArray(item.source_files) ? item.source_files : []
    const pdfPaths = Array.isArray(item.source_pdf_paths) ? item.source_pdf_paths : []
    const pageHints = uniqueSortedNumbers(Array.isArray(item.page_hints) ? item.page_hints : [])
    for (let index = 0; index < pdfPaths.length; index += 1) {
      const pdfPath = String(pdfPaths[index] || "")
      if (!pdfPath) continue
      const sourceFile = String(sourceFiles[index] || path.basename(pdfPath).replace(/\.pdf$/i, ".txt"))
      const existing = byPdf.get(pdfPath)
      if (existing) existing.pageHints = uniqueSortedNumbers([...existing.pageHints, ...pageHints])
      else byPdf.set(pdfPath, { sourceFile, pageHints })
    }
  }

  const files: Array<{ pdfPath: string; textPath: string; mode: string; pageHints: number[] }> = []
  for (const [pdfPath, meta] of byPdf.entries()) {
    if (!(await pathExists(pdfPath))) throw new Error(`Source PDF not found for SkillOpt corpus: ${pdfPath}`)
    const textPath = path.join(transformedRoot, meta.sourceFile)
    const blocks: string[] = [
      `# ${path.basename(pdfPath)}`,
      "",
      `Source PDF: ${pdfPath}`,
      `Corpus mode: ${options.corpusMode}`,
      "",
    ]
    if (options.corpusMode === "full") {
      const rawOut = path.join(rawRoot, `${path.basename(meta.sourceFile, ".txt")}.full.json`)
      const raw = await runOcrHelper({ options, pdfPath, rawOut })
      blocks.push(String(raw.text || "").trim())
    } else {
      const hints = meta.pageHints.length ? meta.pageHints : [undefined]
      for (const pageHint of hints) {
        const suffix = typeof pageHint === "number" ? `page-${pageHint}` : "all"
        const rawOut = path.join(rawRoot, `${path.basename(meta.sourceFile, ".txt")}.${suffix}.json`)
        const raw = await runOcrHelper({ options, pdfPath, rawOut, pageHint })
        blocks.push(`\n\n## OCR window ${suffix}\n\n${String(raw.text || "").trim()}`)
      }
    }
    await writeFile(textPath, blocks.join("\n").trim() + "\n", "utf8")
    files.push({ pdfPath, textPath, mode: options.corpusMode, pageHints: meta.pageHints })
  }

  await writeFile(
    path.join(docsRoot, "corpus-manifest.json"),
    JSON.stringify(
      {
        schema: "auto-evolve-skillopt-officeqa-local-text-corpus/v1",
        docsRoot,
        transformedRoot,
        mode: options.corpusMode,
        fileCount: files.length,
        files,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  return { docsRoot, transformedRoot, fileCount: files.length }
}

async function collectMarkdownFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(root, fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath)
  }
  return files
}

function rankSkillFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase()
  if (normalized.endsWith("/index.md")) return "0000"
  if (normalized.endsWith("/core.md")) return "0001"
  if (normalized.includes("/casebook/")) return "1000" + normalized
  if (normalized.includes("/patches/")) return "2000" + normalized
  return "3000" + normalized
}

async function writeMergedSkill(options: CliOptions) {
  if (!options.skillRoot) return undefined
  const skillOut = options.skillOut || path.join(options.outDir, "merged-skill.md")
  await mkdir(path.dirname(skillOut), { recursive: true })
  const files = (await collectMarkdownFiles(options.skillRoot)).sort((a, b) => rankSkillFile(a).localeCompare(rankSkillFile(b)))
  const parts: string[] = [
    "# Auto-Evolve SkillOpt Bridge Skill",
    "",
    `Source skill root: ${options.skillRoot}`,
    "",
    "This file is a flattened copy of the Auto-Evolve skill workspace for SkillOpt eval-only runs.",
    "",
  ]
  for (const file of files) {
    const rel = path.relative(options.skillRoot, file).replace(/\\/g, "/")
    parts.push(`\n\n---\n\n## File: ${rel}\n\n${(await readText(file)).trim()}\n`)
  }
  await writeFile(skillOut, parts.join("\n").trim() + "\n", "utf8")
  return { skillOut, fileCount: files.length }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(options.outDir, { recursive: true })
  const split = await writeSplitDir(options)
  const skill = await writeMergedSkill(options)
  const docs = await writeLocalTextCorpus(options, split.items)
  const summary = {
    schema: "auto-evolve-skillopt-officeqa-bridge-summary/v1",
    outDir: options.outDir,
    splitRoot: split.splitRoot,
    splitName: options.splitName,
    itemCount: split.items.length,
    mergedSkillPath: skill?.skillOut,
    mergedSkillFileCount: skill?.fileCount,
    localDocsRoot: docs?.docsRoot,
    localDocsTransformedRoot: docs?.transformedRoot,
    localDocsFileCount: docs?.fileCount,
    skilloptEvalCommand: skill
      ? [
          'cd "C:\\Users\\ZhuanZ\\Desktop\\SkillOpt"',
          docs ? `$env:OFFICEQA_DOCS_DIR="${docs.docsRoot}"` : undefined,
          "python scripts/eval_only.py",
          "  --config configs/officeqa/default.yaml",
          `  --skill "${skill.skillOut}"`,
          `  --split ${options.splitName}`,
          `  --split_dir "${split.splitRoot}"`,
          `  --out_root "${path.join(options.outDir, "skillopt-eval-run")}"`,
        ].filter(Boolean).join(" `\n")
      : undefined,
  }
  await writeFile(path.join(options.outDir, "bridge-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8")
  console.log(`SkillOpt bridge exported: ${options.outDir}`)
  console.log(`Split dir: ${split.splitRoot}`)
  if (skill?.skillOut) console.log(`Merged skill: ${skill.skillOut}`)
  if (docs?.docsRoot) console.log(`SkillOpt docs root: ${docs.docsRoot}`)
}

await main()
