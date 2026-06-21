import { readFileSync } from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import type { DirectChatMaterial, DirectChatModelConfig, DirectChatPromptAudit } from "./contract"
import { isCertifiedDocumentAsset, resolveDirectChatProviderCapabilities } from "./providers/capabilities"

export function estimateDirectChatTokens(text: string) {
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  // Deliberately conservative. The previous chars/4 estimate under-counted
  // real provider input by roughly 50% on OfficeQA prompts.
  return Math.ceil(ascii / 3 + nonAscii / 1.2)
}

function sanitizeMaterialForDirectChat(material: DirectChatMaterial) {
  if (material.id !== "instruction") return material.content
  return material.content
    .replace(/^Write the final answer to workspace\/answer\.txt\.\s*$/gim, "")
    .replace(/^The answer file must contain only the final answer value, with no explanation\.\s*$/gim, "")
    .replace(/^For example,\s*write\s+`?[^`\r\n]+`?\s+rather than a sentence\.\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function mimeFromPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".webp") return "image/webp"
  if (extension === ".gif") return "image/gif"
  if (extension === ".pdf") return "application/pdf"
  return "application/octet-stream"
}

function dataURL(filePath: string, mimeType?: string) {
  const bytes = readFileSync(filePath)
  return `data:${mimeType || mimeFromPath(filePath)};base64,${bytes.toString("base64")}`
}

export function resolvePromptBudget(model: DirectChatModelConfig) {
  const maxOutput = model.maxOutputTokens ?? 2048
  const context = model.contextWindowTokens ?? 32768
  return model.promptBudgetTokens ?? Math.max(4096, context - maxOutput - 1024)
}

export function buildBudgetedPrompt(input: {
  skillBundle: string
  caseID: string
  model: DirectChatModelConfig
  question: string
  outputInstruction: string
  materials: DirectChatMaterial[]
  encodeAssets?: boolean
  skillAudit?: {
    tier?: string
    sourceOriginalTokens?: number
    selectionTruncated?: boolean
  }
}) {
  const promptBudget = resolvePromptBudget(input.model)
  const systemOverheadTokens = 220
  const userOverheadTokens = estimateDirectChatTokens(input.question) + estimateDirectChatTokens(input.outputInstruction) + 220
  const skillBudget = input.model.skillBudgetTokens ?? promptBudget
  const skillOriginalTokens = estimateDirectChatTokens(input.skillBundle)
  const includedSkillTokens = skillOriginalTokens
  if (input.skillBundle.trim() && includedSkillTokens > skillBudget) {
    throw new Error(
      `Direct Chat skill publication exceeds model budget for ${input.model.id}: ${includedSkillTokens}/${skillBudget} estimated tokens. ` +
        "Publish a smaller direct-chat-skill.md or increase the explicit model budget; automatic truncation is forbidden.",
    )
  }
  const materialBudget =
    input.model.materialBudgetTokens ??
    Math.max(1000, promptBudget - systemOverheadTokens - userOverheadTokens - includedSkillTokens)
  const totalMaterialTokens = input.materials.reduce(
    (sum, material) => sum + estimateDirectChatTokens(sanitizeMaterialForDirectChat(material)),
    0,
  )
  if (totalMaterialTokens > materialBudget) {
    throw new Error(
      `Direct Chat materials exceed model budget for ${input.model.id}/${input.caseID}: ${totalMaterialTokens}/${materialBudget} estimated tokens. ` +
        "The dataset adapter must publish a smaller, auditable material bundle; prompt-layer truncation is forbidden.",
    )
  }

  const materialAudits: DirectChatPromptAudit["materials"] = []
  const warnings: string[] = []
  const assetParts: Array<Record<string, any>> = []
  const providerCapabilities = resolveDirectChatProviderCapabilities(input.model)
  const renderedMaterials = input.materials.map((material) => {
    if (material.type === "image_asset") {
      const assetPath = material.metadata?.assetPathInternal || material.metadata?.imagePathInternal || material.sourcePathInternal
      const imageInputMode = providerCapabilities.imageInputMode
      if (imageInputMode === "none") {
        warnings.push(`Model does not declare image input support: ${material.id}`)
      } else if (imageInputMode !== "openai-image-url") {
        warnings.push(`Model ${input.model.id} declares unsupported image input mode ${imageInputMode}: ${material.id}`)
      } else if (assetPath && input.encodeAssets !== false) {
        assetParts.push({
          type: "image_url",
          image_url: { url: dataURL(assetPath, material.metadata?.mimeType) },
        })
      }
    }
    if (material.type === "document_asset") {
      const assetPath = material.metadata?.assetPathInternal || material.sourcePathInternal
      const fileInputMode = providerCapabilities.fileInputMode
      const documentLabel = (path.extname(assetPath || "") || "document").replace(/^\./, "").toUpperCase()
      if (providerCapabilities.uncertifiedDocumentReason && !isCertifiedDocumentAsset(input.model, assetPath)) {
        warnings.push(
          `Provider ${providerCapabilities.providerID} is not certified for native ${documentLabel} input in Direct Chat: ${material.id} (${providerCapabilities.uncertifiedDocumentReason})`,
        )
      } else if (fileInputMode === "none") {
        warnings.push(`Model does not declare file/PDF input support: ${material.id}`)
      } else if (fileInputMode !== "openai-file-data") {
        if (fileInputMode === "siliconflow-image-url-pdf" && assetPath && input.encodeAssets !== false) {
          assetParts.push({
            type: "image_url",
            image_url: { url: dataURL(assetPath, material.metadata?.mimeType) },
          })
        } else {
          warnings.push(`Model ${input.model.id} declares unsupported file input mode ${fileInputMode}: ${material.id}`)
        }
      } else if (assetPath && input.encodeAssets !== false) {
        assetParts.push({
          type: "file",
          file: {
            filename: path.basename(assetPath),
            file_data: dataURL(assetPath, material.metadata?.mimeType),
          },
        })
      }
    }
    const content = sanitizeMaterialForDirectChat(material)
    const materialTokens = estimateDirectChatTokens(content)
    materialAudits.push({
      id: material.id,
      title: material.title,
      type: material.type,
      originalTokens: materialTokens,
      includedTokens: materialTokens,
      truncated: false,
      pageHint: material.metadata?.pageHint,
      extractedPages: material.metadata?.extractedPages,
    })
    return [`## ${material.id}: ${material.title}`, `Type: ${material.type}`, content.trim()].join("\n")
  })

  const commonSystemRules = [
    "Your job:",
    "- Find the specific requested values in the materials.",
    "- Do any required arithmetic yourself.",
    "- Respect wording such as calendar year, fiscal year, month, quarter, total, average, nominal dollars, and percent; do not substitute a nearby table with a different time basis.",
    "- For document questions with source page hints, prioritize evidence from the hinted page and immediately adjacent pages before using farther pages.",
    "- Return the final answer in the exact requested format.",
    "",
    "Output rule:",
    "- Your entire response must be exactly one XML-like answer tag: <answer>FINAL_ANSWER_ONLY</answer>.",
    "- Do not write anything before or after the <answer> tag.",
    "- Inside <answer>, put only the final value, JSON array/object, or exact string answer.",
    "- Do not put explanation, units, markdown, citations, or reasoning anywhere in the response.",
    "- If evidence is hard to read, still provide your best final answer in the required format; do not explain uncertainty.",
    "",
    "Do not call tools. Do not write files. Do not claim that files are inaccessible. Do not mention this evaluation harness.",
  ]
  const skillText = input.skillBundle.trim()
  const system = (skillText
    ? [
        "You are solving one benchmark question in a single chat response.",
        "",
        "The prompt has exactly three useful input sections:",
        "1. <SKILL> is the expert guidance learned during training. Treat it as a method guide, not as task data.",
        "2. <QUESTION> is the current test question. Answer this question only.",
        "3. <MATERIALS> contains the source evidence for this question. Use it as the evidence source.",
        "",
        "Follow the skill to decide how to read the question and materials.",
        ...commonSystemRules,
        "",
        "<SKILL>",
        skillText,
        "</SKILL>",
        "",
        "DIRECT CHAT OVERRIDE AFTER SKILL:",
        "- The skill may mention writing output files. In this Direct Chat run, there is no writable workspace.",
        "- Convert any file-writing instruction into: return the answer inside the <answer> tag.",
        "- Ignore skill rules about Python scripts, OCR engines, PDF tools, shell commands, workspace files, tool-call recording, blank-eval, or sandbox setup.",
        "- Use only the text and assets already present in <MATERIALS>; do not ask to inspect external files.",
        "- Never output scratch work, calculation logs, checklists, or explanation.",
        "- Any response that is not exactly one <answer> tag is invalid.",
      ]
    : [
        "You are solving one benchmark question in a single chat response.",
        "",
        "Use only the current <QUESTION>, the supplied <MATERIALS>, and the <OUTPUT_INSTRUCTION>.",
        "There is no external guidance, memory, workspace, or tool access.",
        "",
        ...commonSystemRules,
        "",
        "Use only the text and assets already present in <MATERIALS>; do not ask to inspect external files.",
        "Never output scratch work, calculation logs, checklists, or explanation.",
        "Any response that is not exactly one <answer> tag is invalid.",
      ]
  ).join("\n")
  const user = [
    "Use the sections below as follows:",
    "- <QUESTION>: the exact task to solve.",
    "- <MATERIALS>: source evidence already prepared for this model. For OfficeQA SkillOpt mode, these are official parsed page texts from the referenced Treasury Bulletin pages.",
    "- <OUTPUT_INSTRUCTION>: the required final answer shape.",
    "",
    "<QUESTION>",
    input.question.trim(),
    "</QUESTION>",
    "",
    "<MATERIALS>",
    renderedMaterials.join("\n\n"),
    "</MATERIALS>",
    "",
    "<OUTPUT_INSTRUCTION>",
    input.outputInstruction,
    "",
    "FINAL DIRECT CHAT OUTPUT CONTRACT:",
    "Return exactly one line:",
    "<answer>FINAL_ANSWER_ONLY</answer>",
    "Do not include reasoning. Do not include calculations. Do not include file-writing instructions. Do not include markdown.",
    "</OUTPUT_INSTRUCTION>",
  ].join("\n")
  const estimatedPromptTokens = estimateDirectChatTokens(system) + estimateDirectChatTokens(user)
  if (estimatedPromptTokens > promptBudget) {
    throw new Error(
      `Estimated Direct Chat prompt exceeds model budget for ${input.model.id}/${input.caseID}: ${estimatedPromptTokens}/${promptBudget}.`,
    )
  }
  const audit: DirectChatPromptAudit = {
    schema: "direct-chat-prompt-audit/v1",
    caseID: input.caseID,
    modelID: input.model.id,
    promptBudgetTokens: promptBudget,
    estimatedPromptTokens,
    skill: {
      originalTokens: skillOriginalTokens,
      sanitizedTokens: skillOriginalTokens,
      includedTokens: includedSkillTokens,
      truncated: false,
      selectionTruncated: Boolean(input.skillAudit?.selectionTruncated),
      sourceOriginalTokens: input.skillAudit?.sourceOriginalTokens ?? skillOriginalTokens,
      tier: input.skillAudit?.tier,
      sha256: crypto.createHash("sha256").update(input.skillBundle).digest("hex"),
    },
    materials: materialAudits,
    warnings,
  }
  const userContent = assetParts.length
    ? [{ type: "text", text: user }, ...assetParts]
    : user
  return { messages: [{ role: "system" as const, content: system }, { role: "user" as const, content: userContent }], audit }
}
