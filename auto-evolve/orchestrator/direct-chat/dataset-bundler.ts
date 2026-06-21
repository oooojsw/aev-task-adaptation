import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type {
  DirectChatCaseBundle,
  DirectChatDatasetManifest,
  DirectChatMaterialAudit,
  DirectChatValidatorOracle,
} from "./contract"

type AnyRecord = Record<string, any>

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function parseQuestion(instruction: string) {
  const match = instruction.match(/Question:\s*([\s\S]*?)(?:\n\n[A-Z][A-Za-z ]+:|\nDifficulty:|\nSource document URLs:|\nLocal source PDFs:|$)/)
  return match?.[1]?.trim() || instruction.trim()
}

function parseLocalSources(instruction: string) {
  const block = instruction.match(/Local source PDFs:\s*([\s\S]*?)(?:\n\n|$)/)?.[1] || ""
  const sources = block
    .split(/\r?\n/g)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
  return sources
}

function parseSourcePageHints(instruction: string) {
  return parseSourceDocs(instruction).map((url) => {
    const match = url.match(/[?&]page=(\d+)/i)
    return match ? Number(match[1]) : undefined
  })
}

function parseSourceDocs(instruction: string) {
  const block = instruction.match(/Source document URLs:\s*([\s\S]*?)(?:\n\nLocal source PDFs:|\n\n|$)/)?.[1] || ""
  return block
    .split(/\r?\n/g)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean)
}

const MONTH_NUMBER: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
}

function sourceDocumentKeyFromURL(sourceDoc: string) {
  const match = sourceDoc.toLowerCase().match(/\/([a-z]+)-(\d{4})-\d+(?:\?|$)/)
  if (!match) return undefined
  const month = MONTH_NUMBER[match[1]!]
  return month ? `${match[2]}_${month}` : undefined
}

function sourceDocumentKeyFromPath(sourcePath: string) {
  const stem = path.basename(sourcePath, path.extname(sourcePath)).toLowerCase()
  return stem.match(/(?:treasury_bulletin_)?(\d{4})_(\d{2})/)?.slice(1, 3).join("_")
}

function alignOfficeQaSource(sourceDoc: string, localSources: string[], sourceDocCount: number, index: number) {
  const sourceKey = sourceDocumentKeyFromURL(sourceDoc)
  if (sourceKey) {
    const matched = localSources.find((source) => sourceDocumentKeyFromPath(source) === sourceKey)
    if (matched) return matched
  }
  if (localSources.length === 1) return localSources[0]
  if (localSources.length === sourceDocCount) return localSources[index]
  return undefined
}

function parseSplitIDs(raw: unknown) {
  if (Array.isArray(raw)) return raw.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean)
  if (raw && typeof raw === "object") {
    const record = raw as AnyRecord
    for (const key of ["ids", "tasks", "train", "test", "cases"]) {
      if (Array.isArray(record[key])) return parseSplitIDs(record[key])
    }
  }
  return []
}

function resolveMaybeRelative(baseDir: string, value: string | undefined) {
  if (!value) return undefined
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value)
}

function readValidatorOracle(taskDir: string, spec: AnyRecord): DirectChatValidatorOracle | undefined {
  const validators = Array.isArray(spec.validators) ? spec.validators : []
  const validator = validators.find((item) => item?.path && (!item?.type || item.type === "script"))
  if (!validator) return undefined
  const args = Array.isArray(validator.args) ? validator.args.map(String) : []
  const getArg = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const pathArgNames = new Set(["--answer-path", "--answer", "--expected", "--reward"])
  const resolvedArgs = args.map((value, index) => {
    const previous = args[index - 1]
    if (pathArgNames.has(previous)) return resolveMaybeRelative(taskDir, value) ?? value
    return value
  })
  const toleranceRaw = getArg("--tolerance")
  return {
    validatorID: String(validator.id),
    runner: String(validator.runner || "python"),
    scriptPath: resolveMaybeRelative(taskDir, String(validator.path || "")),
    args: resolvedArgs,
    candidateArgName: args.includes("--candidate") ? "--candidate" : undefined,
    answerPath: resolveMaybeRelative(taskDir, getArg("--answer-path") || getArg("--answer")),
    rewardPath: resolveMaybeRelative(taskDir, getArg("--reward")),
    tolerance: toleranceRaw ? Number(toleranceRaw) : undefined,
  }
}

async function runProcess(command: string, args: string[]) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
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

async function pdfAssetMaterial(input: { taskDir: string; source: string; sourceIndex: number; pageHint?: number }) {
  const pdfPath = path.resolve(input.taskDir, input.source)
  if (!(await pathExists(pdfPath))) {
    return { material: undefined, warning: `Missing PDF source: ${input.source}`, omitted: input.source }
  }
  return {
    material: {
      id: `pdf-${path.basename(input.source, path.extname(input.source)).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title: path.basename(input.source),
      type: "document_asset" as const,
      content: [
        `PDF material: ${path.basename(input.source)}`,
        "No local PDF text extraction was performed.",
        "The target model must use its own native PDF/file understanding capability for this material.",
      ].join("\n"),
      sourcePathInternal: pdfPath,
      metadata: {
        sourceIndex: input.sourceIndex,
        pageHint: input.pageHint,
        assetPathInternal: pdfPath,
        mimeType: "application/pdf",
        requiresModelFileCapability: true,
      },
    },
    warning: "PDF material requires model-native file/PDF capability; no local extraction was performed.",
    omitted: undefined,
  }
}

function officeQaDocsRootCandidates(input?: string) {
  return [
    input,
    process.env.OFFICEQA_DOCS_DIR,
    "C:/Users/ZhuanZ/Desktop/experiment/datasets/OfficeQA_corpus",
    "E:/project/experiment/datasets/OfficeQA_corpus",
    "C:/Users/ZhuanZ/Desktop/experiment/datasets/OfficeQA_corpus/treasury_bulletins_parsed",
    "E:/project/experiment/datasets/OfficeQA_corpus/treasury_bulletins_parsed",
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => path.resolve(item))
}

async function locateOfficeQaParsedJson(input: { source: string; docsDir?: string }) {
  const stem = path.basename(input.source, path.extname(input.source))
  const jsonName = `${stem}.json`
  for (const root of officeQaDocsRootCandidates(input.docsDir)) {
    for (const candidate of [
      path.join(root, "treasury_bulletins_parsed", "jsons", jsonName),
      path.join(root, "jsons", jsonName),
      path.join(path.dirname(root), "jsons", jsonName),
    ]) {
      if (await pathExists(candidate)) return candidate
    }
  }
  return undefined
}

function stripHtmlToText(input: string) {
  let text = input
    .replace(/<\/tr>\s*<tr[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
  }
  for (const [from, to] of Object.entries(entities)) text = text.replaceAll(from, to)
  return text
    .split(/\r?\n/g)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

function elementPageIDs(element: AnyRecord) {
  const ids = new Set<number>()
  const boxes = Array.isArray(element.bbox) ? element.bbox : []
  for (const box of boxes) {
    const pageID = Number((box as AnyRecord)?.page_id)
    if (Number.isFinite(pageID)) ids.add(pageID)
  }
  return ids
}

async function renderOfficeQaParsedPage(input: { jsonPath: string; pageNumber: number; maxChars?: number }) {
  const parsed = await readJsonFile<AnyRecord>(input.jsonPath)
  const elements = Array.isArray(parsed?.document?.elements) ? parsed.document.elements : []
  const sections: string[] = []
  for (const element of elements) {
    if (!element || typeof element !== "object") continue
    if (!elementPageIDs(element as AnyRecord).has(input.pageNumber)) continue
    const content = (element as AnyRecord).content
    if (typeof content !== "string" || !content.trim() || content.trim().toLowerCase() === "none") continue
    const text = stripHtmlToText(content)
    if (text) sections.push(text)
  }
  const joined = sections.join("\n\n").trim()
  const maxChars = input.maxChars ?? 24000
  if (joined.length <= maxChars) return { text: joined, originalChars: joined.length, truncated: false }
  return {
    text: `${joined.slice(0, maxChars).trimEnd()}\n\n[... ${joined.length - maxChars} characters omitted from this official parsed page ...]`,
    originalChars: joined.length,
    truncated: true,
  }
}

async function officeQaSkillOptOracleMaterials(input: {
  taskDir: string
  localSources: string[]
  sourceDocs: string[]
  docsDir?: string
}) {
  const materials: DirectChatCaseBundle["materials"] = []
  const warnings: string[] = []
  const omittedSources: string[] = []
  const seen = new Set<string>()
  let totalChars = 0
  const maxTotalChars = 80000

  for (let index = 0; index < input.sourceDocs.length; index += 1) {
    const sourceDoc = input.sourceDocs[index]
    const pageMatch = sourceDoc.match(/[?&]page=(\d+)/i)
    const pageNumber = pageMatch ? Number(pageMatch[1]) : undefined
    if (!pageNumber || !Number.isFinite(pageNumber)) {
      warnings.push(`Source URL has no page hint: ${sourceDoc}`)
      continue
    }
    const localSource = alignOfficeQaSource(sourceDoc, input.localSources, input.sourceDocs.length, index)
    if (!localSource) {
      omittedSources.push(sourceDoc)
      warnings.push(`No local source file aligned to source URL: ${sourceDoc}`)
      continue
    }
    const jsonPath = await locateOfficeQaParsedJson({
      source: localSource.replace(/\.pdf$/i, ".json"),
      docsDir: input.docsDir,
    })
    if (!jsonPath) {
      omittedSources.push(`${localSource}#page=${pageNumber}`)
      warnings.push(`Missing OfficeQA official parsed JSON for ${localSource}`)
      continue
    }
    const key = `${jsonPath}#${pageNumber}`
    if (seen.has(key)) continue
    seen.add(key)
    const renderedPage = await renderOfficeQaParsedPage({ jsonPath, pageNumber })
    if (!renderedPage.text) {
      omittedSources.push(`${localSource}#page=${pageNumber}`)
      warnings.push(`Official parsed JSON had no text for ${path.basename(localSource)} page ${pageNumber}`)
      continue
    }
    const block = [
      `Official SkillOpt/OfficeQA oracle parsed page.`,
      `Source file: ${path.basename(localSource).replace(/\.pdf$/i, ".txt")}`,
      `Source URL: ${sourceDoc}`,
      `Page: ${pageNumber}`,
      ``,
      renderedPage.text,
    ].join("\n")
    if (totalChars + block.length > maxTotalChars) {
      omittedSources.push(`${localSource}#page=${pageNumber}`)
      for (let remainingIndex = index + 1; remainingIndex < input.sourceDocs.length; remainingIndex += 1) {
        omittedSources.push(input.sourceDocs[remainingIndex]!)
      }
      warnings.push(`Oracle parsed page context exceeded the ${maxTotalChars} character dataset publication limit`)
      break
    }
    totalChars += block.length
    materials.push({
      id: `officeqa-oracle-page-${materials.length + 1}`,
      title: `${path.basename(localSource)} page ${pageNumber} (official parsed text)`,
      type: "markdown",
      content: block,
      sourcePathInternal: jsonPath,
      metadata: {
        sourceIndex: index,
        pageHint: pageNumber,
        extractionEngine: "skillopt-officeqa-official-parsed-json",
        originalCharCount: renderedPage.originalChars,
        truncatedAtExtraction: renderedPage.truncated,
      },
    })
    if (renderedPage.truncated) {
      warnings.push(
        `Official parsed page ${path.basename(localSource)}#${pageNumber} was capped at 24000 characters from ${renderedPage.originalChars}`,
      )
    }
  }

  return { materials, warnings, omittedSources }
}

async function listTaskIDs(taskPackRoot: string) {
  const tasksRoot = path.join(taskPackRoot, "tasks")
  const entries = await readdir(tasksRoot, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

async function materializeGenericSource(input: { taskDir: string; sourcePath: string; label?: string; role?: string; sourceIndex: number }) {
  const absolute = path.resolve(input.taskDir, input.sourcePath)
  const extension = path.extname(input.sourcePath).toLowerCase()
  const title = input.label || path.basename(input.sourcePath)
  if (!(await pathExists(absolute))) {
    return { material: undefined, warning: `Missing material: ${input.sourcePath}`, omitted: input.sourcePath }
  }
  if (extension === ".md" || extension === ".txt" || extension === ".json" || extension === ".jsonl" || extension === ".yaml" || extension === ".yml") {
    return {
      material: {
        id: `material-${input.sourceIndex + 1}`,
        title,
        type: extension === ".md" ? ("markdown" as const) : ("text" as const),
        content: await readFile(absolute, "utf8"),
        sourcePathInternal: absolute,
        metadata: { sourceIndex: input.sourceIndex },
      },
      warning: undefined,
      omitted: undefined,
    }
  }
  if (extension === ".pdf") {
    const extracted = await pdfAssetMaterial({
      taskDir: input.taskDir,
      source: input.sourcePath,
      sourceIndex: input.sourceIndex,
    })
    return extracted
  }
  if (extension === ".xlsx" || extension === ".xlsm") {
    const scriptPath = path.resolve(import.meta.dir, "..", "..", "scripts", "materialize-xlsx-for-direct-chat.py")
    const result = await runProcess("python", [scriptPath, "--xlsx", absolute])
    if (result.exitCode !== 0) {
      return { material: undefined, warning: `XLSX materialization failed for ${input.sourcePath}: ${result.stderr || result.stdout}`, omitted: input.sourcePath }
    }
    return {
      material: {
        id: `xlsx-${path.basename(input.sourcePath, extension).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        title,
        type: "table" as const,
        content: result.stdout.trim(),
        sourcePathInternal: absolute,
        metadata: { sourceIndex: input.sourceIndex },
      },
      warning: undefined,
      omitted: undefined,
    }
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"].includes(extension)) {
    return {
      material: {
        id: `image-${path.basename(input.sourcePath, extension).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        title,
        type: "image_asset" as const,
        content: [
          `Image material: ${title}`,
          "This Direct Chat adapter does not OCR or summarize the image.",
          "A target model may use its own image capability only if the configured provider/transport supports image inputs.",
          "For text-only providers, this material is only a pointer and should be treated as unavailable visual evidence.",
        ].join("\n"),
        sourcePathInternal: absolute,
        metadata: {
          sourceIndex: input.sourceIndex,
          imagePathInternal: absolute,
          assetPathInternal: absolute,
          mimeType: extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg",
          requiresModelImageCapability: true,
        },
      },
      warning: "Image material passed as model-capability-dependent pointer; no OCR was performed.",
      omitted: undefined,
    }
  }
  return { material: undefined, warning: `Unsupported material type for direct-chat: ${input.sourcePath}`, omitted: input.sourcePath }
}

export async function buildGenericTaskPackDirectChatDataset(input: {
  taskPackRoot: string
  splitPath?: string
  outDir: string
  splitName?: string
  limit?: number
  allowOmittedMaterials?: boolean
}) {
  const taskPackRoot = path.resolve(input.taskPackRoot)
  const outDir = path.resolve(input.outDir)
  const splitName = input.splitName || (input.splitPath ? path.basename(input.splitPath, path.extname(input.splitPath)) : "all")
  await ensureDirectory(outDir)
  let ids = input.splitPath ? parseSplitIDs(await readJsonFile(input.splitPath)) : await listTaskIDs(taskPackRoot)
  if (input.limit && input.limit > 0) ids = ids.slice(0, input.limit)
  if (ids.length === 0) throw new Error("No case IDs found for direct-chat dataset bundle")

  const bundlePath = path.join(outDir, "direct-chat-dataset.bundle.jsonl")
  const manifestPath = path.join(outDir, "direct-chat-dataset.manifest.json")
  const auditDir = path.join(outDir, "material-audit")
  await ensureDirectory(auditDir)
  const cases: DirectChatCaseBundle[] = []

  for (const id of ids) {
    const taskDir = path.join(taskPackRoot, "tasks", id)
    const specPath = path.join(taskDir, "spec.json")
    if (!(await pathExists(specPath))) throw new Error(`Missing spec.json for ${id}`)
    const spec = await readJsonFile<AnyRecord>(specPath)
    const specMaterials = Array.isArray(spec.materials) ? spec.materials : []
    const materials: DirectChatCaseBundle["materials"] = []
    const warnings: string[] = []
    const omittedSources: string[] = []
    for (let index = 0; index < specMaterials.length; index += 1) {
      const item = specMaterials[index] || {}
      if (typeof item.path !== "string") continue
      const materialized = await materializeGenericSource({
        taskDir,
        sourcePath: item.path,
        label: item.label,
        role: item.role,
        sourceIndex: index,
      })
      if (materialized.material) materials.push(materialized.material)
      if (materialized.warning) warnings.push(materialized.warning)
      if (materialized.omitted) omittedSources.push(materialized.omitted)
    }
    const audit: DirectChatMaterialAudit = {
      caseID: id,
      expectedSources: specMaterials.map((item) => normalizeSlash(String(item.path || ""))).filter(Boolean),
      includedMaterials: materials.map((material) => material.id),
      omittedSources: omittedSources.map((source) => normalizeSlash(source)),
      warnings,
      tokenEstimate: estimateTokens(materials.map((material) => material.content).join("\n")),
      compressionPolicy: "generic-materialization",
    }
    if (audit.omittedSources.length && !input.allowOmittedMaterials) {
      throw new Error(`Case ${id} has omitted source material: ${audit.omittedSources.join(", ")}`)
    }
    await writeJsonFile(path.join(auditDir, `${id}.material-audit.json`), audit)
    cases.push({
      schema: "direct-chat-case/v1",
      caseID: id,
      dataset: path.basename(taskPackRoot),
      split: splitName,
      taskRoot: taskDir,
      question: {
        text: String(spec.goal || spec.title || id),
        answerFormat: "dataset-specific",
        outputInstruction: "Return only the final answer artifact content expected by the task. Do not include explanation.",
      },
      materials,
      privateOracle: readValidatorOracle(taskDir, spec),
      materialAudit: audit,
      metadata: { sourceTaskRoot: taskDir },
    })
  }

  await writeTextFile(bundlePath, cases.map((item) => JSON.stringify(item)).join("\n") + "\n")
  const manifest: DirectChatDatasetManifest = {
    schema: "direct-chat-dataset-manifest/v1",
    dataset: path.basename(taskPackRoot),
    split: splitName,
    caseCount: cases.length,
    bundlePath,
    privateAnswerRoot: path.join(taskPackRoot, "private-answers"),
    materialAuditSummary: {
      casesWithOmittedSources: cases.filter((item) => item.materialAudit.omittedSources.length > 0).length,
      casesWithWarnings: cases.filter((item) => item.materialAudit.warnings.length > 0).length,
    },
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(manifestPath, manifest)
  return { bundlePath, manifestPath, auditDir, manifest, cases }
}

export async function buildOfficeQADirectChatDataset(input: {
  taskPackRoot: string
  splitPath?: string
  outDir: string
  splitName?: string
  limit?: number
  allowOmittedMaterials?: boolean
  extractPdfText?: boolean
  maxPdfCharsPerFile?: number
  officeqaMaterialMode?: "native-pdf" | "skillopt-oracle-json"
  officeqaDocsDir?: string
}) {
  const taskPackRoot = path.resolve(input.taskPackRoot)
  const outDir = path.resolve(input.outDir)
  const splitName = input.splitName || (input.splitPath ? path.basename(input.splitPath, path.extname(input.splitPath)) : "all")
  await ensureDirectory(outDir)

  let ids = input.splitPath ? parseSplitIDs(await readJsonFile(input.splitPath)) : await listTaskIDs(taskPackRoot)
  if (input.limit && input.limit > 0) ids = ids.slice(0, input.limit)
  if (ids.length === 0) throw new Error("No case IDs found for direct-chat dataset bundle")

  const bundlePath = path.join(outDir, "direct-chat-dataset.bundle.jsonl")
  const manifestPath = path.join(outDir, "direct-chat-dataset.manifest.json")
  const auditDir = path.join(outDir, "material-audit")
  await ensureDirectory(auditDir)

  const cases: DirectChatCaseBundle[] = []
  for (const id of ids) {
    const taskDir = path.join(taskPackRoot, "tasks", id)
    const instructionPath = path.join(taskDir, "instruction.md")
    const specPath = path.join(taskDir, "spec.json")
    if (!(await pathExists(instructionPath))) throw new Error(`Missing instruction.md for ${id}`)
    if (!(await pathExists(specPath))) throw new Error(`Missing spec.json for ${id}`)

    const instruction = await readFile(instructionPath, "utf8")
    const spec = await readJsonFile<AnyRecord>(specPath)
    const localSources = parseLocalSources(instruction)
    const sourceDocs = parseSourceDocs(instruction)
    const pageHints = parseSourcePageHints(instruction)
    const expectedSources = (sourceDocs.length ? sourceDocs : localSources).map((source) => normalizeSlash(source))
    const materials: DirectChatCaseBundle["materials"] = [
      {
        id: "instruction",
        title: "OfficeQA task instruction",
        type: "markdown" as const,
        content: instruction.trim(),
        sourcePathInternal: instructionPath,
      },
    ]
    const warnings: string[] = []
    const omittedSources: string[] = []
    const materialMode = input.officeqaMaterialMode || "native-pdf"
    if (materialMode === "skillopt-oracle-json") {
      const oracle = await officeQaSkillOptOracleMaterials({
        taskDir,
        localSources,
        sourceDocs,
        docsDir: input.officeqaDocsDir,
      })
      materials.push(...oracle.materials)
      warnings.push(...oracle.warnings)
      omittedSources.push(...oracle.omittedSources)
    } else {
      for (const source of localSources.filter((item) => item.toLowerCase().endsWith(".pdf"))) {
        const sourceIndex = localSources.indexOf(source)
        const extracted = await pdfAssetMaterial({
          taskDir,
          source,
          sourceIndex,
          pageHint: pageHints[sourceIndex],
        })
        if (extracted.material) materials.push(extracted.material)
        if (extracted.warning) warnings.push(extracted.warning)
        if (extracted.omitted) omittedSources.push(extracted.omitted)
      }
    }
    const audit: DirectChatMaterialAudit = {
      caseID: id,
      expectedSources,
      includedMaterials: materials.map((material) => material.id),
      omittedSources: omittedSources.map((source) => normalizeSlash(source)),
      warnings,
      tokenEstimate: estimateTokens(materials.map((material) => material.content).join("\n")),
      compressionPolicy:
        materialMode === "skillopt-oracle-json"
          ? "instruction-plus-skillopt-official-oracle-parsed-pages"
          : "instruction-plus-native-pdf-assets",
    }
    if (audit.omittedSources.length && !input.allowOmittedMaterials) {
      throw new Error(
        `Case ${id} has omitted source material. Re-run with --allow-omitted-materials only for an explicit text-only baseline.`,
      )
    }

    const bundle: DirectChatCaseBundle = {
      schema: "direct-chat-case/v1",
      caseID: id,
      dataset: "officeqa-pro",
      split: splitName,
      taskRoot: taskDir,
      question: {
        text: parseQuestion(instruction),
        answerFormat: "number-or-short-text",
        outputInstruction: "Only output the final answer value. Do not include explanation, units, labels, or markdown.",
      },
      materials,
      privateOracle: readValidatorOracle(taskDir, spec),
      materialAudit: audit,
      metadata: {
        sourceTaskRoot: taskDir,
      },
    }
    await writeJsonFile(path.join(auditDir, `${id}.material-audit.json`), audit)
    cases.push(bundle)
  }

  await writeTextFile(bundlePath, cases.map((item) => JSON.stringify(item)).join("\n") + "\n")
  const materialAuditSummary = {
    casesWithOmittedSources: cases.filter((item) => item.materialAudit.omittedSources.length > 0).length,
    casesWithWarnings: cases.filter((item) => item.materialAudit.warnings.length > 0).length,
  }
  const manifest: DirectChatDatasetManifest = {
    schema: "direct-chat-dataset-manifest/v1",
    dataset: "officeqa-pro",
    split: splitName,
    caseCount: cases.length,
    bundlePath,
    privateAnswerRoot: path.join(taskPackRoot, "private-answers"),
    materialAuditSummary,
    createdAt: new Date().toISOString(),
  }
  await writeJsonFile(manifestPath, manifest)
  return { bundlePath, manifestPath, auditDir, manifest, cases }
}

export async function readDirectChatDatasetBundle(bundlePath: string) {
  const raw = await readFile(bundlePath, "utf8")
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DirectChatCaseBundle)
}
