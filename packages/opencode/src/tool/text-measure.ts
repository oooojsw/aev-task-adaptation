import { open } from "node:fs/promises"
import { createHash } from "node:crypto"

export async function measure(file: string) {
  const handle = await open(file, "r")
  try {
    // 有界读取，不让自查长度变成无上限的大文件加载。
    const buffer = Buffer.alloc(1024 * 1024 + 1)
    let size = 0
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size === buffer.length) throw new Error("Text measurement requires a file <=1 MiB")
    const bytes = buffer.subarray(0, size)
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    return { bytes: size, sha256: createHash("sha256").update(bytes).digest("hex"),
      codepoints: Array.from(text).length,
      nfcNonWhitespaceCodepoints: Array.from(text.normalize("NFC").replace(/\s/gu, "")).length,
      note: "Read-only snapshot statistics, not formal acceptance; not tokens." }
  } finally { await handle.close() }
}
