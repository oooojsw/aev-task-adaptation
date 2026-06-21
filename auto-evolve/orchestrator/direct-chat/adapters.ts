import path from "node:path"
import { buildGenericTaskPackDirectChatDataset, buildOfficeQADirectChatDataset } from "./dataset-bundler"

export type DirectChatDatasetAdapterID = "officeqa" | "spreadsheetbench" | "alfworld" | "generic"

export function resolveDirectChatAdapterID(taskPackRoot: string, requested = "auto"): DirectChatDatasetAdapterID {
  const normalized = requested.toLowerCase().replace(/[_-]/g, "")
  if (normalized === "officeqa") return "officeqa"
  if (normalized === "spreadsheetbench" || normalized === "spreadsheet") return "spreadsheetbench"
  if (normalized === "alfworld") return "alfworld"
  if (normalized === "generic") return "generic"
  const pack = path.basename(taskPackRoot).toLowerCase()
  if (pack.includes("officeqa")) return "officeqa"
  if (pack.includes("spreadsheetbench")) return "spreadsheetbench"
  if (pack.includes("alfworld")) return "alfworld"
  return "generic"
}

export async function buildDirectChatDatasetWithAdapter(input: {
  adapterID?: string
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
  const adapterID = resolveDirectChatAdapterID(input.taskPackRoot, input.adapterID || "auto")
  if (adapterID === "officeqa") {
    return await buildOfficeQADirectChatDataset({
      taskPackRoot: input.taskPackRoot,
      splitPath: input.splitPath,
      outDir: input.outDir,
      splitName: input.splitName,
      limit: input.limit,
      allowOmittedMaterials: input.allowOmittedMaterials,
      extractPdfText: input.extractPdfText,
      maxPdfCharsPerFile: input.maxPdfCharsPerFile,
      officeqaMaterialMode: input.officeqaMaterialMode,
      officeqaDocsDir: input.officeqaDocsDir,
    })
  }
  return await buildGenericTaskPackDirectChatDataset({
    taskPackRoot: input.taskPackRoot,
    splitPath: input.splitPath,
    outDir: input.outDir,
    splitName: input.splitName,
    limit: input.limit,
    allowOmittedMaterials: input.allowOmittedMaterials,
  })
}
