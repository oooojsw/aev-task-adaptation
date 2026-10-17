import type {
  DirectChatCallResult,
  DirectChatFileInputMode,
  DirectChatImageInputMode,
  DirectChatMessage,
  DirectChatModelConfig,
} from "../contract"

import type { BudgetTransportConfig } from "../../task-adaptation/budget-transport"

export interface DirectChatProviderCallInput {
  attempt?: number
  caseID?: string
  requestBudgetTransport?: BudgetTransportConfig
  enforceRequestBudget?: boolean
  stableRequestID?: string
}

export interface DirectChatProviderAdapter {
  id: string
  matches(model: DirectChatModelConfig): boolean
  call(
    model: DirectChatModelConfig,
    messages: DirectChatMessage[],
    input?: DirectChatProviderCallInput,
  ): Promise<DirectChatCallResult>
}

export interface DirectChatProviderCapabilities {
  providerID: string
  imageInputMode: DirectChatImageInputMode
  fileInputMode: DirectChatFileInputMode
  certifiedDocumentExtensions: string[]
  uncertifiedDocumentReason?: string
}
