import path from "node:path"
import { rm, writeFile } from "node:fs/promises"
import { ensureDirectory } from "../orchestrator/fs"
import { buildBudgetedPrompt } from "../orchestrator/direct-chat/material-budget"
import type { DirectChatMaterial, DirectChatModelConfig } from "../orchestrator/direct-chat/contract"

async function main() {
  const root = path.resolve(import.meta.dir, "..", ".tmp-direct-chat-siliconflow-smoke", String(Date.now()))
  await rm(root, { recursive: true, force: true })
  await ensureDirectory(root)
  const imagePath = path.join(root, "sample.png")
  const pdfPath = path.join(root, "sample.pdf")
  await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"))
  await writeFile(pdfPath, Buffer.from("%PDF-1.4\n% smoke\n", "utf8"))

  const imageModel: DirectChatModelConfig = {
    id: "siliconflow-vl-smoke",
    provider: "siliconflow",
    transport: "openai-compatible",
    model: "Qwen/Qwen2.5-VL-72B-Instruct",
    supportsImageInputs: true,
    supportsFileInputs: false,
    imageInputMode: "openai-image-url",
    fileInputMode: "none",
  }
  const imageMaterial: DirectChatMaterial = {
    id: "image",
    title: "image",
    type: "image_asset",
    content: "Native image asset; do not locally extract.",
    sourcePathInternal: imagePath,
    metadata: { assetPathInternal: imagePath, mimeType: "image/png" },
  }
  const imagePrompt = buildBudgetedPrompt({
    skillBundle: "Read the visual material.",
    caseID: "IMG",
    model: imageModel,
    question: "What is in the image?",
    outputInstruction: "Return <answer>...</answer>",
    materials: [imageMaterial],
  })
  const userContent = imagePrompt.messages[1]?.content
  if (!Array.isArray(userContent) || !JSON.stringify(userContent).includes('"image_url"')) {
    throw new Error("SiliconFlow image material was not encoded as OpenAI-compatible image_url content.")
  }

  const pdfMaterial: DirectChatMaterial = {
    id: "pdf",
    title: "pdf",
    type: "document_asset",
    content: "Native PDF asset; do not locally extract.",
    sourcePathInternal: pdfPath,
    metadata: { assetPathInternal: pdfPath, mimeType: "application/pdf" },
  }
  const pdfPrompt = buildBudgetedPrompt({
    skillBundle: "Read the document.",
    caseID: "PDF",
    model: imageModel,
    question: "What is in the PDF?",
    outputInstruction: "Return <answer>...</answer>",
    materials: [pdfMaterial],
  })
  if (!pdfPrompt.audit.warnings.some((warning) => warning.includes("not certified for native PDF input"))) {
    throw new Error("SiliconFlow non-OCR PDF material was not blocked as uncertified.")
  }

  const ocrModel: DirectChatModelConfig = {
    id: "siliconflow-deepseek-ocr-pdf-smoke",
    provider: "siliconflow",
    transport: "openai-compatible",
    model: "deepseek-ai/DeepSeek-OCR",
    supportsImageInputs: true,
    supportsFileInputs: true,
    imageInputMode: "openai-image-url",
    fileInputMode: "siliconflow-image-url-pdf",
  }
  const ocrPdfPrompt = buildBudgetedPrompt({
    skillBundle: "Read the PDF document.",
    caseID: "OCRPDF",
    model: ocrModel,
    question: "What is in the PDF?",
    outputInstruction: "Return <answer>...</answer>",
    materials: [pdfMaterial],
  })
  const ocrPdfUserContent = ocrPdfPrompt.messages[1]?.content
  if (!Array.isArray(ocrPdfUserContent) || !JSON.stringify(ocrPdfUserContent).includes("data:application/pdf;base64")) {
    throw new Error("SiliconFlow OCR PDF material was not encoded as image_url data URL content.")
  }
  console.log(`direct-chat siliconflow capability smoke passed: ${root}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
