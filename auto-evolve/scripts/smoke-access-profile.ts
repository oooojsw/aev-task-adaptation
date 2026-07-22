import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { buildAccessProfile } from "../orchestrator/access-profile"
import { autoEvolvePath } from "../orchestrator/fs"

async function expectReject(label: string, fn: () => Promise<unknown>) {
  let rejected = false
  try {
    await fn()
  } catch {
    rejected = true
  }
  assert.equal(rejected, true, `${label} should reject`)
}

async function main() {
  const cwd = process.cwd()
  const root = autoEvolvePath(cwd, "runtime-state", "smoke-access-profile")
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })

  const privateRoot = path.join(root, "private-answers", "case-001")
  await mkdir(privateRoot, { recursive: true })
  const privateAnswer = path.join(privateRoot, "answer.txt")
  await writeFile(privateAnswer, "42", "utf8")

  const openBook = await buildAccessProfile({
    role: "smoke_open_book_worker",
    mode: "open_book",
    readPaths: [path.join(root, "task.md")],
    expertOracleReadPaths: [privateAnswer],
    editPaths: [path.join(root, "draft-skill")],
  })
  assert(openBook.permissionReadPaths.includes(privateAnswer), "open_book should include exact oracle file")
  assert(openBook.permissionEditPaths.includes(path.join(root, "draft-skill")), "open_book should keep edit paths")

  await expectReject("closed_book private answer", () =>
    buildAccessProfile({
      role: "smoke_blank_agent",
      mode: "closed_book",
      readPaths: [privateAnswer],
      editPaths: [path.join(root, "workspace")],
    }),
  )

  await expectReject("closed_book validator input", () =>
    buildAccessProfile({
      role: "smoke_blank_agent",
      mode: "closed_book",
      readPaths: [path.join(root, "validators", "v1", "validator_input.json")],
      editPaths: [path.join(root, "workspace")],
    }),
  )

  const audit = await buildAccessProfile({
    role: "smoke_readonly_audit",
    mode: "readonly_audit",
    readPaths: [root],
    editPaths: [path.join(root, "should-not-write")],
  })
  assert.deepEqual(audit.permissionEditPaths, [], "readonly_audit must erase edit paths")

  console.log(
    JSON.stringify(
      {
        ok: true,
        openBookReads: openBook.permissionReadPaths.length,
        auditReads: audit.permissionReadPaths.length,
      },
      null,
      2,
    ),
  )
}

await main()
