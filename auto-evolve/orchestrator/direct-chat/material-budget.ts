import { readFileSync } from "node:fs"
import path from "node:path"
import type { DirectChatMaterial, DirectChatModelConfig, DirectChatPromptAudit } from "./contract"
import { isCertifiedDocumentAsset, resolveDirectChatProviderCapabilities } from "./providers/capabilities"

export function estimateDirectChatTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function takeApproxTokens(text: string, tokens: number) {
  const maxChars = Math.max(0, tokens * 4)
  if (text.length <= maxChars) return { text, truncated: false }
  if (maxChars <= 200) return { text: text.slice(0, maxChars), truncated: true }
  const head = Math.floor(maxChars * 0.65)
  const tail = Math.max(100, maxChars - head - 120)
  return {
    text: `${text.slice(0, head)}\n\n[...TRUNCATED_TO_FIT_DIRECT_CHAT_CONTEXT...]\n\n${text.slice(-tail)}`,
    truncated: true,
  }
}

function splitPdfPages(content: string) {
  const matches = [...content.matchAll(/^#{2,3}\s+Page\s+(\d+)\s*$/gim)]
  if (!matches.length) return []
  const pages: Array<{ page: number; text: string }> = []
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!
    const start = match.index ?? 0
    const end = i + 1 < matches.length ? matches[i + 1]!.index ?? content.length : content.length
    pages.push({
      page: Number(match[1]),
      text: content.slice(start, end).trim(),
    })
  }
  return pages
}

function scorePage(page: { page: number; text: string }, material: DirectChatMaterial, question: string) {
  let score = 0
  const pageHint = material.metadata?.pageHint
  if (typeof pageHint === "number") score += Math.max(0, 100 - Math.abs(page.page - pageHint) * 25)
  const lower = page.text.toLowerCase()
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length >= 4)
  for (const word of words) if (lower.includes(word)) score += 2
  return score
}

function fitMaterialContent(material: DirectChatMaterial, budgetTokens: number, question: string) {
  const originalTokens = estimateDirectChatTokens(material.content)
  if (originalTokens <= budgetTokens) {
    return { content: material.content.trim(), originalTokens, includedTokens: originalTokens, truncated: false }
  }
  const pages = splitPdfPages(material.content)
  if (pages.length) {
    const sortedPages = pages
      .map((page) => ({ ...page, score: scorePage(page, material, question) }))
      .sort((a, b) => b.score - a.score)
    const selected: typeof sortedPages = []
    let usedTokens = 0
    for (const page of sortedPages) {
      const pageTokens = estimateDirectChatTokens(page.text)
      if (selected.length && usedTokens + pageTokens > budgetTokens) continue
      selected.push(page)
      usedTokens += pageTokens
      if (usedTokens >= budgetTokens) break
    }
    selected.sort((a, b) => a.page - b.page)
    const rendered = selected.map((page) => page.text).join("\n\n")
    if (rendered.trim()) {
      return {
        content: rendered.trim(),
        originalTokens,
        includedTokens: estimateDirectChatTokens(rendered),
        truncated: true,
      }
    }
  }
  const fitted = takeApproxTokens(material.content, budgetTokens)
  return {
    content: fitted.text.trim(),
    originalTokens,
    includedTokens: estimateDirectChatTokens(fitted.text),
    truncated: fitted.truncated,
  }
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
}) {
  const promptBudget = resolvePromptBudget(input.model)
  const systemOverheadTokens = 220
  const userOverheadTokens = estimateDirectChatTokens(input.question) + estimateDirectChatTokens(input.outputInstruction) + 220
  const skillBudget = Math.min(input.model.skillBudgetTokens ?? 6000, Math.max(1000, Math.floor(promptBudget * 0.25)))
  const skillOriginalTokens = estimateDirectChatTokens(input.skillBundle)
  const fittedSkill = takeApproxTokens(input.skillBundle.trim(), skillBudget)
  const includedSkillTokens = estimateDirectChatTokens(fittedSkill.text)
  const materialBudget =
    input.model.materialBudgetTokens ??
    Math.max(1000, promptBudget - systemOverheadTokens - userOverheadTokens - includedSkillTokens)
  const perMaterialBudget = Math.max(500, Math.floor(materialBudget / Math.max(1, input.materials.length)))

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
      } else if (assetPath) {
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
        if (fileInputMode === "siliconflow-image-url-pdf" && assetPath) {
          assetParts.push({
            type: "image_url",
            image_url: { url: dataURL(assetPath, material.metadata?.mimeType) },
          })
        } else {
          warnings.push(`Model ${input.model.id} declares unsupported file input mode ${fileInputMode}: ${material.id}`)
        }
      } else if (assetPath) {
        assetParts.push({
          type: "file",
          file: {
            filename: path.basename(assetPath),
            file_data: dataURL(assetPath, material.metadata?.mimeType),
          },
        })
      }
    }
    const isInstruction = material.id === "instruction"
    const budget = isInstruction ? Math.max(perMaterialBudget, 1200) : perMaterialBudget
    const fitted = fitMaterialContent(material, budget, input.question)
    if (fitted.truncated) warnings.push(`Material truncated for prompt budget: ${material.id}`)
    materialAudits.push({
      id: material.id,
      title: material.title,
      type: material.type,
      originalTokens: fitted.originalTokens,
      includedTokens: fitted.includedTokens,
      truncated: fitted.truncated,
      pageHint: material.metadata?.pageHint,
      extractedPages: material.metadata?.extractedPages,
    })
    return [`## ${material.id}: ${material.title}`, `Type: ${material.type}`, fitted.content].join("\n")
  })

  const system = [
    "You are solving one benchmark question in a single chat response.",
    "",
    "The prompt has exactly three useful input sections:",
    "1. <SKILL> is the expert guidance learned during training. Treat it as a method guide, not as task data.",
    "2. <QUESTION> is the current test question. Answer this question only.",
    "3. <MATERIALS> contains the source materials for this question. Some document materials may be OCR text extracted locally from the original PDF. Use these materials as the evidence source.",
    "",
    "Your job:",
    "- Follow the skill to decide how to read the question and materials.",
    "- Find the specific requested values in the materials.",
    "- Do any required arithmetic yourself.",
    "- Return the final answer in the exact requested format.",
    "",
    "Output rule:",
    "- Your entire response must be exactly one XML-like answer tag: <answer>FINAL_ANSWER_ONLY</answer>.",
    "- Do not write anything before or after the <answer> tag.",
    "- Inside <answer>, put only the final value, JSON array/object, or exact string answer.",
    "- Do not put explanation, units, markdown, citations, or reasoning anywhere in the response.",
    "- If evidence is hard to read, still provide your best final answer in the required format; do not explain uncertainty.",
    "",
    "Do not call tools. Do not claim that files are inaccessible. Do not mention this evaluation harness.",
    "",
    "<SKILL>",
    fittedSkill.text.trim() || "(No skill is provided for this baseline run.)",
    "</SKILL>",
    "",
    "DIRECT CHAT OVERRIDE AFTER SKILL:",
    "- The skill may mention writing files such as workspace/answer.txt. In this Direct Chat run, there is no writable workspace.",
    "- Convert any 'write answer.txt' instruction into: return the answer inside the <answer> tag.",
    "- Never output scratch work, calculation logs, checklists, or explanation.",
    "- If you already know the answer, stop immediately and return only <answer>FINAL_ANSWER_ONLY</answer>.",
    "- Any response that is not exactly one <answer> tag is invalid.",
  ].join("\n")
  const user = [
    "Use the sections below as follows:",
    "- <QUESTION>: the exact task to solve.",
    "- <MATERIALS>: OCR/text/source content to inspect for evidence.",
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
  if (estimatedPromptTokens > promptBudget) warnings.push(`Estimated prompt tokens exceed budget: ${estimatedPromptTokens}/${promptBudget}`)
  const audit: DirectChatPromptAudit = {
    schema: "direct-chat-prompt-audit/v1",
    caseID: input.caseID,
    modelID: input.model.id,
    promptBudgetTokens: promptBudget,
    estimatedPromptTokens,
    skill: {
      originalTokens: skillOriginalTokens,
      includedTokens: includedSkillTokens,
      truncated: fittedSkill.truncated,
    },
    materials: materialAudits,
    warnings,
  }
  const userContent = assetParts.length
    ? [{ type: "text", text: user }, ...assetParts]
    : user
  return { messages: [{ role: "system" as const, content: system }, { role: "user" as const, content: userContent }], audit }
}
