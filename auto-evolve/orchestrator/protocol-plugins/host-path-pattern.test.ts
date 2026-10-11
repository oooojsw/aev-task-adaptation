import { expect, test } from "bun:test"
import path from "node:path"
import { aevPathPattern } from "../../../packages/opencode/src/permission/aev-path-pattern"
import { evaluate } from "../../../packages/opencode/src/permission/evaluate"

test("new host maps edit-relative target to exact absolute grants without sibling escape", () => {
  const root = path.resolve("E:/project/AEV-protocol-plugins-20261011/test-evidence/path-pattern/workspace")
  const rules = [{ permission: "edit", pattern: "*", action: "deny" as const },
    { permission: "edit", pattern: root + "/*", action: "allow" as const }]
  const action = (target: string) => evaluate("edit", aevPathPattern("edit", target, root, true), rules).action
  expect(action("result.txt")).toBe("allow")
  expect(action("nested/result.txt")).toBe("allow")
  expect(action("../private/oracle.json")).toBe("deny")
  expect(action(path.resolve(root, "../private/oracle.json"))).toBe("deny")
  expect(aevPathPattern("edit", "result.txt", root, false)).toBe("result.txt")
  expect(aevPathPattern("bash", "echo marker", root, true)).toBe("echo marker")
})
