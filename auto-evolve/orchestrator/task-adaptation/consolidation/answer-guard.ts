import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { digest } from "./contract"

export interface AnswerGuard {
  path: string
  sha256: string
}
type Row = { caseID: string; question: string; answer: string }

export async function guardRows(guard: AnswerGuard, total: number) {
  if (!path.isAbsolute(guard.path) || !/^[a-f0-9]{64}$/.test(guard.sha256)) throw new Error("Invalid host answer guard binding")
  const stat = await lstat(guard.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2000000) throw new Error("Invalid host answer manifest file")
  const bytes = await readFile(guard.path)
  if (digest(bytes) !== guard.sha256) throw new Error("Host answer manifest drift")
  const rows = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")) as Row[]
  if (!Array.isArray(rows) || rows.length !== total || new Set(rows.map(row => row.caseID)).size !== total ||
    rows.some(row => !/^UID\d{4}$/.test(row.caseID) || typeof row.question !== "string" || !row.question.trim() ||
      typeof row.answer !== "string" || !row.answer.trim())) throw new Error("Invalid host answer manifest rows")
  return rows
}

export function answerLeak(text: string, rows: Row[]): { rule: string; caseID: string } | undefined {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
  const check = (value: string, encoded = false) => {
    const content = normalize(value)
    for (const row of rows) {
      const answer = normalize(row.answer)
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}.])${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}.])`, "u")
      // 数字单独出现不拒绝，只拦可定位的题目到答案映射。
      const uid = normalize(row.caseID)
      const question = normalize(row.question)
      const index = content.indexOf(uid)
      if (index >= 0 && pattern.test(content.slice(index + uid.length, index + uid.length + 180)))
        return { rule: encoded ? "encoded_uid_answer" : "uid_answer", caseID: row.caseID }
      if (question.length >= 40 && content.includes(question) && pattern.test(content.replace(question, "")))
        return { rule: encoded ? "encoded_question_answer" : "question_answer", caseID: row.caseID }
    }
  }
  const direct = check(text)
  if (direct) return direct
  // 仅解码有限大小的完整编码串，不把任意数字误当隐藏答案。
  for (const match of text.matchAll(/[A-Za-z0-9+/]{16,}={0,2}|\b(?:[a-fA-F0-9]{2}){12,}\b/g)) {
    if (match[0].length > 100000) continue
    for (const encoding of ["base64", "hex"] as const) {
      const decoded = Buffer.from(match[0], encoding).toString("utf8")
      const found = check(decoded, true)
      if (found) return found
    }
  }
}
