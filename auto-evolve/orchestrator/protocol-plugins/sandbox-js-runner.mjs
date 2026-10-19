import { readFileSync } from "node:fs"
import vm from "node:vm"

// 固定运行器只接收声明输入；候选无宿主文件、网络或进程接口。
const input = JSON.parse(readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""))
const source = input.candidate.map(item => readFileSync(item.path, "utf8")).join("\n")
const materials = input.materials.map(item => ({ id: item.id, content: readFileSync(item.path, "utf8") }))
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate",
})
const script = new vm.Script(`"use strict"; JSON.stringify((()=>{\n${source}\nreturn solve(${JSON.stringify(materials)});\n})())`)
const result = script.runInContext(context, { timeout: 1000 })
if (typeof result !== "string") throw new Error("Synchronous JSON result required")
console.log(JSON.stringify({ result: JSON.parse(result) }))
