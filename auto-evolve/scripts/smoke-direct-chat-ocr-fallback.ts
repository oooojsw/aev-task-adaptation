import path from "node:path"
import { rm, writeFile } from "node:fs/promises"
import { ensureDirectory, readJsonFile } from "../orchestrator/fs"
import type { DirectChatMaterial, DirectChatModelsConfig } from "../orchestrator/direct-chat/contract"
import { prepareDirectChatMaterialsForModel } from "../orchestrator/direct-chat/ocr-fallback"

function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ]
  let body = "%PDF-1.4\n"
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, "utf8"))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body, "utf8")
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, "utf8")
}

async function main() {
  const root = path.resolve(import.meta.dir, "..", ".tmp-direct-chat-ocr-fallback", String(Date.now()))
  await rm(root, { recursive: true, force: true })
  await ensureDirectory(root)
  const pdfPath = path.join(root, "sample.pdf")
  const helperPath = path.join(root, "fake-local-ocr.py")
  await writeFile(pdfPath, minimalPdf())
  await writeFile(
    helperPath,
    [
      "import argparse, json, pathlib",
      "p = argparse.ArgumentParser()",
      "p.add_argument('--input', required=True)",
      "p.add_argument('--output', required=True)",
      "p.add_argument('--umi-exe', required=True)",
      "args = p.parse_args()",
      "pathlib.Path(args.output).write_text(json.dumps({",
      "  'schema': 'direct-chat-local-ocr/v1',",
      "  'engine': 'local-umi',",
      "  'text': '## Page 1\\nRevenue: 42',",
      "  'pages': [{'page': 1, 'lineCount': 1}]",
      "}, ensure_ascii=False, indent=2), encoding='utf-8')",
      "",
    ].join("\n"),
    "utf8",
  )

  const models: DirectChatModelsConfig = {
    models: {
      target: {
        provider: "siliconflow",
        transport: "openai-compatible",
        model: "Qwen/Qwen3.6-35B-A3B",
        supportsImageInputs: false,
        supportsFileInputs: false,
        imageInputMode: "none",
        fileInputMode: "none",
      },
    },
    retry: { maxAttempts: 1, backoffMs: 1 },
    ocrFallback: {
      enabled: true,
      mode: "local-umi",
      pythonBin: "python",
      helperScriptPath: helperPath,
      umiExePath: "E:/project/Umi-OCR_Paddle_v2.1.5/UmiOCR-data/plugins/win7_x64_PaddleOCR-json/PaddleOCR-json.exe",
    },
  }

  const materials: DirectChatMaterial[] = [
    {
      id: "pdf-source",
      title: "Source PDF",
      type: "document_asset",
      content: "Native PDF asset",
      sourcePathInternal: pdfPath,
      metadata: {
        assetPathInternal: pdfPath,
        mimeType: "application/pdf",
        requiresModelFileCapability: true,
      },
    },
  ]

  const prepared = await prepareDirectChatMaterialsForModel({
    caseID: "OCR001",
    model: { ...models.models.target, id: "target" },
    modelsConfig: models,
    materials,
    caseDir: root,
  })

  if (prepared.materials.length !== 1) throw new Error("Expected one prepared material.")
  const material = prepared.materials[0]
  if (material.type !== "markdown") throw new Error(`Expected OCR fallback markdown material, got ${material.type}`)
  if (!material.content.includes("Revenue: 42")) throw new Error("OCR fallback text missing from prepared material.")

  const routing = await readJsonFile<any>(path.join(root, "material-routing.json"))
  if (routing.routes?.[0]?.action !== "ocr_fallback") throw new Error("Routing audit did not record OCR fallback.")
  console.log(`direct-chat OCR fallback smoke passed: ${root}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
