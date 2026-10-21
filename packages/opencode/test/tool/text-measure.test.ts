import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { measure } from "../../src/tool/text-measure"

test("measurement uses complete unnumbered NFC Unicode codepoints, not bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aev-measure-"))
  try {
    const file = path.join(dir, "candidate.md")
    await writeFile(file, "\uFEFFe\u0301 \r\n中😀\t")
    const value = await measure(file)
    expect(value.nfcNonWhitespaceCodepoints).toBe(3)
    expect(value.bytes).toBe(Buffer.byteLength("\uFEFFe\u0301 \r\n中😀\t"))
    expect(value.sha256).toHaveLength(64)
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 65))
    await expect(measure(file)).rejects.toThrow("1 MiB")
    await writeFile(file, Buffer.from([0xff]))
    await expect(measure(file)).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
