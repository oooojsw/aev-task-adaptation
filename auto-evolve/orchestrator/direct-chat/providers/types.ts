import type {
  DirectChatCallResult,
  DirectChatFileInputMode,
  DirectChatImageInputMode,
  DirectChatMessage,
  DirectChatModelConfig,
} from "../contract"

export interface DirectChatProviderCallInput {
  attempt?: number
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
