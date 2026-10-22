import {expect,test} from "bun:test"
import {mkdtemp,writeFile,readFile} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {runDirectChatEvaluation} from "./runner"

test("thinking-only output remains invalid while raw reply and billed usage survive",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"aev-no-final-"))
 const skill=path.join(root,"skill.md"),dataset=path.join(root,"cases.jsonl"),out=path.join(root,"out")
 await writeFile(skill,"Use public evidence.")
 await writeFile(dataset,JSON.stringify({schema:"direct-chat-case/v1",caseID:"case1",dataset:"synthetic",split:"train",
  question:{text:"What is the result?",outputInstruction:"Return a number"},materials:[],
  materialAudit:{caseID:"case1",expectedSources:[],includedMaterials:[],omittedSources:[],warnings:[],tokenEstimate:0,compressionPolicy:"none"}})+"\n")
 let calls=0
 const server=Bun.serve({port:0,fetch:()=>{calls++;return Response.json({model:"fixture",content:[{type:"thinking",thinking:"not a final answer"}],stop_reason:"max_tokens",usage:{input_tokens:10,output_tokens:20}})}})
 try{
  const result=await runDirectChatEvaluation({cwd:root,skillBundlePath:skill,datasetBundlePath:dataset,outDir:out,
   models:{models:{consumer:{transport:"anthropic-messages",baseURL:`http://127.0.0.1:${server.port}/v1`,apiKey:"local-fixture",model:"fixture",maxOutputTokens:20,contextWindowTokens:20000,promptBudgetTokens:10000}},retry:{maxAttempts:1,backoffMs:0},transientRecovery:{enabled:false}},
   modelIDs:["consumer"],globalConcurrency:1,includeNoSkillBaseline:false,updateMasterReport:false,skillInputMode:"full"})
  const row=result.results[0]!
  expect(calls).toBe(1);expect(row.passed).toBe(false);expect(row.errorCategory).toBe("parse")
  expect(row.attempts).toBe(1);expect(row.outputBudgetExceeded).toBe(true);expect(row.usage?.outputTokens).toBe(20)
  expect(row.finishReason).toBe("length");expect(row.answer).toBe("")
  const raw=JSON.parse(await readFile(row.responseAuditPath!,"utf8"))
  expect(raw.raw.content[0]).toEqual({type:"thinking",thinking:"not a final answer"})
  expect(raw.raw).not.toHaveProperty("apiKey")
 }finally{server.stop(true)}
})
