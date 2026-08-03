import type { Provider } from "./provider"
import type { ModelsDev } from "./models"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

export namespace ProviderMediaCapability {
  export function modality(mime: string): Modality | undefined {
    if (mime.startsWith("image/")) return "image"
    if (mime.startsWith("audio/")) return "audio"
    if (mime.startsWith("video/")) return "video"
    if (mime === "application/pdf") return "pdf"
    return undefined
  }

  export function supportsInput(model: Provider.Model, mime: string) {
    const input = modality(mime)
    return input ? model.capabilities.input[input] === true : true
  }

  export function unsupportedInputMessage(mime: string, filename?: string) {
    const input = modality(mime) ?? "file"
    const name = filename ? `"${filename}"` : input
    return `ERROR: Cannot read ${name} (this model does not support ${input} input). Inform the user.`
  }
}
