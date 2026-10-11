import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

function section(source: string, start: string, end: string) {
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error("Unexpected permission source boundary")
  return source.slice(source.indexOf(start), source.indexOf(end))
}

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const work = path.join(root, "workspace")
  const materials = path.join(root, "materials")
  await mkdir(work, { recursive: true })
  await mkdir(materials)
  const publicFile = path.join(materials, "public.txt")
  const privateFile = path.join(materials, "oracle.json")
  await writeFile(publicFile, "Public")
  await writeFile(privateFile, "PRIVATE_PERMISSION_FIXTURE")
  const hostPath = path.resolve(import.meta.dir, "../opencode.ts")
  const repo = path.resolve(import.meta.dir, "../../..")
  const wildcardPath = path.join(repo, "packages/opencode/src/util/wildcard.ts")
  const evaluatePath = path.join(repo, "packages/opencode/src/permission/evaluate.ts")
  const permissionPath = path.join(repo, "packages/opencode/src/permission/index.ts")
  const host = await readFile(hostPath, "utf8")
  const wildcard = await readFile(wildcardPath, "utf8")
  const evaluate = await readFile(evaluatePath, "utf8")
  const permission = await readFile(permissionPath, "utf8")
  const builder = (source: string) => section(source, "function addPermissionPathVariants(", "function filterProviderPlugins(")
  const baseline = (await promisify(execFile)("git", ["show", "7d8b7d36d4f5357fb69b4079393cd4f3e28d2293:auto-evolve/orchestrator/opencode.ts"], { cwd: repo })).stdout
  const writeModule = async (name: string, body: string) => {
    const file = path.join(root, `${name}.ts`)
    await writeFile(file, body)
    return import(pathToFileURL(file).href)
  }
  // 只导出实际纯函数，不加载会话、模型或改写匹配算法。
  const prefix = 'import path from "node:path"; import os from "node:os"; import {stat,realpath} from "node:fs/promises";\n'
  const current = await writeModule("current", prefix + builder(host) + "\nexport {makeOverridePermissions};")
  const old = await writeModule("baseline", prefix + builder(baseline) + "\nexport {makeOverridePermissions};")
  const engine = await writeModule("engine", prefix +
    section(wildcard, "export namespace Wildcard {", "  export function all(") + "}\n" +
    evaluate.replace('import { Wildcard } from "@/util/wildcard"', "") +
    section(permission, "  function expand(", "  export function merge(")
      .replace("Config.Permission", "Record<string, any>").replace("const ruleset: Ruleset", "const ruleset: Rule[]"))
  await writeFile(path.join(root, "source-fingerprints.json"), JSON.stringify(Object.fromEntries([
    [hostPath, host], [wildcardPath, wildcard], [evaluatePath, evaluate], [permissionPath, permission],
  ].map(([file, source]) => [file, createHash("sha256").update(source).digest("hex")]))))
  return { root, work, materials, publicFile, privateFile, current, old, engine }
}

test("legacy permission configuration remains equal to pre-upgrade source", async () => {
  const f = await fixture()
  const request = { readPaths: [f.publicFile], editPaths: [f.work], allowShell: false }
  expect(await f.current.makeOverridePermissions(f.root, request)).toEqual(await f.old.makeOverridePermissions(f.root, request))
})

test("declared external traversal allows public files but does not grant sibling oracle or source edits", async () => {
  const f = await fixture()
  const config = await f.current.makeOverridePermissions(f.root,
    { readPaths: [f.publicFile], editPaths: [f.work], allowShell: false, externalPaths: [f.materials, f.work] })
  const rules = f.engine.fromConfig(config)
  const action = (name: string, target: string) => f.engine.evaluate(name, target, rules).action
  expect(action("external_directory", path.join(f.materials, "*"))).toBe("allow")
  expect(action("read", f.publicFile)).toBe("allow")
  expect(action("read", f.privateFile)).toBe("deny")
  expect(action("list", f.materials)).toBe("deny")
  expect(action("edit", f.publicFile)).toBe("deny")
  expect(action("edit", path.join(f.work, "answer.txt"))).toBe("allow")
  expect(action("read", path.join(f.root, "outside.txt"))).toBe("deny")
  expect(action("external_directory", path.join(f.root, "outside", "*"))).toBe("deny")
  for (const name of ["bash", "task", "webfetch", "skill", "grep", "glob"]) expect(action(name, "*")).toBe("deny")
})
