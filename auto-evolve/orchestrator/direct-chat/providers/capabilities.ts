import path from "node:path"
import type { DirectChatModelConfig } from "../contract"
import type { DirectChatProviderCapabilities } from "./types"

function isSiliconFlowPdfModel(model: DirectChatModelConfig) {
  const value = `${model.model || ""} ${model.id || ""}`.toLowerCase()
  return value.includes("deepseek-ocr") || value.includes("paddleocr-vl")
}

export function resolveDirectChatProviderCapabilities(model: DirectChatModelConfig): DirectChatProviderCapabilities {
  if (model.provider === "siliconflow") {
    if (isSiliconFlowPdfModel(model)) {
      return {
        providerID: "siliconflow",
        imageInputMode: "openai-image-url",
        fileInputMode: "siliconflow-image-url-pdf",
        certifiedDocumentExtensions: [".pdf"],
      }
    }
    return {
      providerID: "siliconflow",
      imageInputMode: model.imageInputMode || (model.supportsImageInputs ? "openai-image-url" : "none"),
      fileInputMode: "none",
      certifiedDocumentExtensions: [],
      uncertifiedDocumentReason:
        "SiliconFlow PDF input is certified only for OCR/document models such as DeepSeek-OCR/PaddleOCR-VL that accept PDF through image_url.",
    }
  }

  return {
    providerID: model.provider || model.transport || model.id,
    imageInputMode: model.imageInputMode || (model.supportsImageInputs ? "openai-image-url" : "none"),
    fileInputMode: model.fileInputMode || (model.supportsFileInputs ? "openai-file-data" : "none"),
    certifiedDocumentExtensions: model.fileInputMode === "openai-file-data" || model.supportsFileInputs ? [".pdf"] : [],
  }
}

export function isCertifiedDocumentAsset(model: DirectChatModelConfig, assetPath?: string) {
  const extension = path.extname(assetPath || "").toLowerCase()
  const capabilities = resolveDirectChatProviderCapabilities(model)
  return Boolean(extension && capabilities.certifiedDocumentExtensions.includes(extension))
}
