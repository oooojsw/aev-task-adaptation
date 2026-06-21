import path from "node:path"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type {
  DirectChatMaterial,
  DirectChatMaterialRoutingAudit,
  DirectChatModelConfig,
  DirectChatModelsConfig,
} from "./contract"
import { isCertifiedDocumentAsset, resolveDirectChatProviderCapabilities } from "./providers/capabilities"

function mimeFromPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".webp") return "image/webp"
  if (extension === ".gif") return "image/gif"
  if (extension === ".pdf") return "application/pdf"
  return "application/octet-stream"
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

function resolveLocalOcrSettings(config: DirectChatModelsConfig) {
  const helperScriptPath =
    config.ocrFallback?.helperScriptPath || path.resolve(import.meta.dir, "..", "..", "scripts", "direct-chat-local-ocr.py")
  const pythonBin = config.ocrFallback?.pythonBin || "python"
  const umiExePath =
    config.ocrFallback?.umiExePath ||
    "E:/project/Umi-OCR_Paddle_v2.1.5/UmiOCR-data/plugins/win7_x64_PaddleOCR-json/PaddleOCR-json.exe"
  const cacheRoot = config.ocrFallback?.cacheRoot ? path.resolve(config.ocrFallback.cacheRoot) : undefined
  const renderScriptPath = path.resolve(import.meta.dir, "..", "..", "scripts", "render-pdf-pages-for-direct-chat.py")
  return { helperScriptPath, pythonBin, umiExePath, cacheRoot, renderScriptPath }
}

async function computeCacheKey(input: {
  engineID: string
  assetPath: string
  mimeType?: string
  materialID: string
  pageHint?: number
  pageWindow?: number
}) {
  const bytes = await readFile(input.assetPath)
  return createHash("sha256")
    .update(input.engineID)
    .update("\n")
    .update(input.materialID)
    .update("\n")
    .update(input.mimeType || "")
    .update("\n")
    .update(typeof input.pageHint === "number" ? String(input.pageHint) : "")
    .update("\n")
    .update(typeof input.pageWindow === "number" ? String(input.pageWindow) : "")
    .update("\n")
    .update(bytes)
    .digest("hex")
}

async function runOcrFallback(input: {
  caseID: string
  material: DirectChatMaterial
  assetPath: string
  mimeType?: string
  cacheRoot: string
  modelsConfig: DirectChatModelsConfig
}) {
  const settings = resolveLocalOcrSettings(input.modelsConfig)
  const engineID = input.modelsConfig.ocrFallback?.mode || "local-umi"
  const pageHint = typeof input.material.metadata?.pageHint === "number" ? input.material.metadata.pageHint : undefined
  const configuredPageWindow =
    typeof input.material.metadata?.pageWindow === "number"
      ? input.material.metadata.pageWindow
      : typeof input.modelsConfig.ocrFallback?.pageWindow === "number"
        ? input.modelsConfig.ocrFallback.pageWindow
        : 4
  const pageWindow = typeof pageHint === "number" ? Math.max(0, Math.floor(configuredPageWindow)) : undefined
  const key = await computeCacheKey({
    engineID,
    assetPath: input.assetPath,
    mimeType: input.mimeType,
    materialID: input.material.id,
    pageHint,
    pageWindow,
  })
  const cacheDir = path.join(settings.cacheRoot || input.cacheRoot, "ocr-cache")
  const cachePath = path.join(cacheDir, `${key}.json`)
  if (await pathExists(cachePath)) {
    const cached = await readJsonFile<{ text: string; engine: string }>(cachePath)
    return {
      text: cached.text,
      engine: cached.engine || engineID,
      cacheHit: true,
      cachePath,
    }
  }

  await ensureDirectory(cacheDir)
  const rawPath = path.join(cacheDir, `${key}.raw.json`)
  const ocrArgs = [
    settings.helperScriptPath,
    "--input",
    input.assetPath,
    "--output",
    rawPath,
    "--umi-exe",
    settings.umiExePath,
  ]
  if (typeof pageHint === "number") {
    ocrArgs.push("--page-hint", String(pageHint))
    if (typeof pageWindow === "number") ocrArgs.push("--page-window", String(pageWindow))
  }
  const processResult = await runProcess(settings.pythonBin, ocrArgs)
  if (processResult.exitCode !== 0) {
    throw new Error(
      `Local OCR fallback failed for ${input.caseID}/${input.material.id}: ${processResult.stderr || processResult.stdout || "unknown error"}`,
    )
  }
  const raw = await readJsonFile<{ text?: string; engine?: string; pages?: Array<{ page: number; lineCount: number }> }>(rawPath)
  const text = String(raw.text || "").trim()
  if (!text) throw new Error(`Local OCR fallback returned empty text for ${input.caseID}/${input.material.id}`)
  await writeJsonFile(cachePath, {
    schema: "direct-chat-ocr-cache/v1",
    caseID: input.caseID,
    materialID: input.material.id,
    engine: raw.engine || engineID,
    sourcePath: input.assetPath,
    pageHint,
    pageWindow,
    createdAt: new Date().toISOString(),
    text,
    pages: raw.pages || [],
  })
  return {
    text,
    engine: raw.engine || engineID,
    cacheHit: false,
    cachePath,
  }
}

async function renderPdfPagesForImageModel(input: {
  caseID: string
  material: DirectChatMaterial
  assetPath: string
  cacheRoot: string
  modelsConfig: DirectChatModelsConfig
}) {
  const settings = resolveLocalOcrSettings(input.modelsConfig)
  const pageHint = typeof input.material.metadata?.pageHint === "number" ? input.material.metadata.pageHint : undefined
  const configuredPageWindow =
    typeof input.material.metadata?.pageWindow === "number"
      ? input.material.metadata.pageWindow
      : typeof input.modelsConfig.ocrFallback?.pageWindow === "number"
        ? input.modelsConfig.ocrFallback.pageWindow
        : 1
  const pageWindow = typeof pageHint === "number" ? Math.max(0, Math.floor(configuredPageWindow)) : undefined
  const renderDpi = Math.max(96, Math.floor(input.modelsConfig.ocrFallback?.pdfRenderDpi ?? 200))
  const key = await computeCacheKey({
    engineID: `pdf-page-render-v1-dpi-${renderDpi}`,
    assetPath: input.assetPath,
    mimeType: "application/pdf",
    materialID: input.material.id,
    pageHint,
    pageWindow,
  })
  const renderRoot = path.join(settings.cacheRoot || input.cacheRoot, "pdf-page-images", key)
  const manifestPath = path.join(renderRoot, "manifest.json")
  if (await pathExists(manifestPath)) {
    const cached = await readJsonFile<{ pages: Array<{ page: number; path: string }> }>(manifestPath)
    return { pages: cached.pages, cacheHit: true, manifestPath }
  }

  await ensureDirectory(renderRoot)
  const args = [
    settings.renderScriptPath,
    "--input",
    input.assetPath,
    "--output-dir",
    renderRoot,
    "--dpi",
    String(renderDpi),
  ]
  if (typeof pageHint === "number") {
    args.push("--page-hint", String(pageHint))
    if (typeof pageWindow === "number") args.push("--page-window", String(pageWindow))
  }
  const processResult = await runProcess(settings.pythonBin, args)
  if (processResult.exitCode !== 0) {
    throw new Error(
      `PDF page rendering failed for ${input.caseID}/${input.material.id}: ${processResult.stderr || processResult.stdout || "unknown error"}`,
    )
  }
  const rendered = JSON.parse(processResult.stdout.trim()) as { pages?: Array<{ page: number; path: string }> }
  const pages = rendered.pages || []
  if (!pages.length) throw new Error(`PDF page rendering returned no pages for ${input.caseID}/${input.material.id}`)
  await writeJsonFile(manifestPath, {
    schema: "direct-chat-pdf-page-images/v1",
    caseID: input.caseID,
    materialID: input.material.id,
    sourcePath: input.assetPath,
    pageHint,
    pageWindow,
    createdAt: new Date().toISOString(),
    pages,
  })
  return { pages, cacheHit: false, manifestPath }
}

export async function prepareDirectChatMaterialsForModel(input: {
  caseID: string
  model: DirectChatModelConfig
  modelsConfig: DirectChatModelsConfig
  materials: DirectChatMaterial[]
  caseDir: string
}) {
  const routes: DirectChatMaterialRoutingAudit["routes"] = []
  const prepared: DirectChatMaterial[] = []
  const ocrEnabled = input.modelsConfig.ocrFallback?.enabled !== false
  const capabilities = resolveDirectChatProviderCapabilities(input.model)

  for (const material of input.materials) {
    if (material.type !== "document_asset" && material.type !== "image_asset") {
      prepared.push(material)
      routes.push({
        materialID: material.id,
        title: material.title,
        type: material.type,
        action: "kept_text",
        reason: "text-like material already directly promptable",
        outputMaterialID: material.id,
      })
      continue
    }

    const assetPath = material.metadata?.assetPathInternal || material.metadata?.imagePathInternal || material.sourcePathInternal
    if (!assetPath) {
      prepared.push(material)
      routes.push({
        materialID: material.id,
        title: material.title,
        type: material.type,
        action: "kept_text",
        reason: "asset path missing; keeping original material description",
        outputMaterialID: material.id,
      })
      continue
    }

    const mimeType = material.metadata?.mimeType || mimeFromPath(assetPath)
    const imageSupported = material.type === "image_asset" && capabilities.imageInputMode === "openai-image-url"
    const documentSupported =
      material.type === "document_asset" &&
      capabilities.fileInputMode !== "none" &&
      isCertifiedDocumentAsset(input.model, assetPath)

    if (imageSupported || documentSupported) {
      prepared.push(material)
      routes.push({
        materialID: material.id,
        title: material.title,
        type: material.type,
        action: "kept_native_asset",
        reason: imageSupported ? "target model supports native image input" : "target model supports certified native document input",
        outputMaterialID: material.id,
      })
      continue
    }

    if (
      material.type === "document_asset" &&
      path.extname(assetPath).toLowerCase() === ".pdf" &&
      capabilities.imageInputMode === "openai-image-url"
    ) {
      const rendered = await renderPdfPagesForImageModel({
        caseID: input.caseID,
        material,
        assetPath,
        cacheRoot: input.caseDir,
        modelsConfig: input.modelsConfig,
      })
      for (const page of rendered.pages) {
        prepared.push({
          id: `${material.id}__page_${page.page}`,
          title: `${material.title} (Page ${page.page})`,
          type: "image_asset",
          content: `Rendered image of PDF page ${page.page}. Inspect the image directly for layout, labels, and numeric table values.`,
          sourcePathInternal: page.path,
          metadata: {
            ...material.metadata,
            pageHint: page.page,
            imagePathInternal: page.path,
            assetPathInternal: page.path,
            mimeType: "image/png",
            requiresModelFileCapability: false,
            requiresModelImageCapability: true,
          },
        })
      }
      routes.push({
        materialID: material.id,
        title: material.title,
        type: material.type,
        action: "rendered_pdf_pages",
        reason: `target model supports images but not native PDF input; rendered ${rendered.pages.length} hinted PDF page image(s)`,
        engine: "pymupdf",
        cacheHit: rendered.cacheHit,
        cachePath: rendered.manifestPath,
        outputMaterialID: rendered.pages.map((page) => `${material.id}__page_${page.page}`).join(","),
      })
      continue
    }

    if (!ocrEnabled) {
      prepared.push(material)
      routes.push({
        materialID: material.id,
        title: material.title,
        type: material.type,
        action: "kept_native_asset",
        reason: "OCR fallback disabled; original asset left for downstream capability guard",
        outputMaterialID: material.id,
      })
      continue
    }

    const ocr = await runOcrFallback({
      caseID: input.caseID,
      material,
      assetPath,
      mimeType,
      cacheRoot: input.caseDir,
      modelsConfig: input.modelsConfig,
    })
    const fallbackMaterial: DirectChatMaterial = {
      id: `${material.id}__ocr`,
      title: `${material.title} (OCR Fallback)`,
      type: "markdown",
      content: [
        `OCR fallback extracted locally from ${path.basename(assetPath)}.`,
        `Original asset placeholder: ${path.basename(assetPath)} (${material.type}).`,
        "",
        ocr.text,
      ].join("\n"),
      metadata: {
        ...material.metadata,
        originalCharCount: ocr.text.length,
        ocrFallbackEngine: ocr.engine,
        ocrSourceMaterialID: material.id,
        ocrSourcePathInternal: assetPath,
        ocrCachePath: ocr.cachePath,
        requiresModelFileCapability: false,
        requiresModelImageCapability: false,
      },
    }
    prepared.push(fallbackMaterial)
    routes.push({
      materialID: material.id,
      title: material.title,
      type: material.type,
      action: "ocr_fallback",
      reason:
        material.type === "document_asset"
          ? `target model cannot consume certified native document input; OCR fallback used`
          : `target model cannot consume native image input; OCR fallback used`,
      engine: ocr.engine,
      cacheHit: ocr.cacheHit,
      cachePath: ocr.cachePath,
      outputMaterialID: fallbackMaterial.id,
    })
  }

  const audit: DirectChatMaterialRoutingAudit = {
    schema: "direct-chat-material-routing-audit/v1",
    caseID: input.caseID,
    modelID: input.model.id,
    routes,
  }
  await writeJsonFile(path.join(input.caseDir, "material-routing.json"), audit)
  await writeTextFile(
    path.join(input.caseDir, "material-routing.md"),
    [
      `# Material Routing`,
      ``,
      `- case: ${input.caseID}`,
      `- model: ${input.model.id}`,
      ``,
      ...routes.map((route) => `- ${route.materialID}: ${route.action} (${route.reason}${route.engine ? `; engine=${route.engine}` : ""})`),
      ``,
    ].join("\n"),
  )
  return { materials: prepared, audit }
}
