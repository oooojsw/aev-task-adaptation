import crypto from "node:crypto"
import path from "node:path"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function treeDigest(root: string) {
  const rows: string[] = []
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute).replace(/\\/g, "/")
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        const body = await readFile(absolute)
        rows.push(`${relative}:${crypto.createHash("sha256").update(body).digest("hex")}`)
      }
    }
  }
  await walk(root)
  return crypto.createHash("sha256").update(rows.join("\n")).digest("hex")
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const root = path.join(repoRoot, "auto-evolve", ".tmp-smoke", "skillopt-native-eval")
  await rm(root, { recursive: true, force: true })
  const fakeSkillOpt = path.join(root, "external-skillopt")
  const splitRoot = path.join(fakeSkillOpt, "data", "officeqa_id_split")
  const scriptPath = path.join(fakeSkillOpt, "scripts", "eval_only.py")
  await mkdir(path.dirname(scriptPath), { recursive: true })
  await mkdir(path.join(fakeSkillOpt, "configs", "officeqa"), { recursive: true })
  for (const split of ["train", "val", "test"]) await mkdir(path.join(splitRoot, split), { recursive: true })
  await writeTextFile(path.join(fakeSkillOpt, "configs", "officeqa", "default.yaml"), "env:\n  name: officeqa\n")
  await writeJsonFile(path.join(splitRoot, "train", "items.json"), [
    { id: "case-pass", question: "pass" },
    { id: "case-unused", question: "unused" },
  ])
  await writeJsonFile(path.join(splitRoot, "val", "items.json"), [{ id: "case-fail", question: "fail" }])
  await writeJsonFile(path.join(splitRoot, "test", "items.json"), [{ id: "case-test-pass", question: "pass" }])
  await writeFile(
    scriptPath,
    [
      "import argparse, json, os",
      "p=argparse.ArgumentParser()",
      "p.add_argument('--config'); p.add_argument('--skill'); p.add_argument('--split')",
      "p.add_argument('--out_root'); p.add_argument('--split_dir'); p.add_argument('--workers')",
      "p.add_argument('--max_api_workers'); p.add_argument('--cfg-options', nargs='+')",
      "p.add_argument('--target_backend'); p.add_argument('--target_model'); p.add_argument('--reasoning_effort')",
      "a=p.parse_args()",
      "if os.environ.get('SMOKE_REQUIRE_DATA_DIRS') == '1':",
      "  values=[x for x in a.cfg_options if x.startswith('env.data_dirs=')]",
      "  if not values: raise RuntimeError('missing env.data_dirs override')",
      "if os.environ.get('SMOKE_EXPECT_KEY') and os.environ.get('MINIMAX_API_KEY') != os.environ.get('SMOKE_EXPECT_KEY'):",
      "  raise RuntimeError('auth snapshot credential did not override ambient environment')",
      "name={'train':'train','valid_seen':'val','valid_unseen':'test'}[a.split]",
      "with open(os.path.join(a.split_dir,name,'items.json'),encoding='utf-8') as f: items=json.load(f)",
      "os.makedirs(a.out_root,exist_ok=True)",
      "rows=[]",
      "for item in items:",
      "  hard=1 if item['id'].endswith('pass') else 0",
      "  infra=os.environ.get('SMOKE_INFRA') == '1' and item['id'] == 'case-fail'",
      "  rows.append({'id':item['id'],'hard':hard if not infra else 0,'soft':float(hard) if not infra else 0.0,'agent_ok':not infra,'fail_reason':'error: infrastructure_missing_evidence: smoke' if infra else ('' if hard else 'mock miss')})",
      "if os.environ.get('SMOKE_EXTRA_ID') == '1': rows.append({'id':'unexpected-case','hard':1,'soft':1.0,'agent_ok':True})",
      "with open(os.path.join(a.out_root,'results.jsonl'),'w',encoding='utf-8') as f:",
      "  for row in rows: f.write(json.dumps(row)+'\\n')",
      "hard=sum(row['hard'] for row in rows)/len(rows) if rows else 0",
      "count=len(rows)+(1 if os.environ.get('SMOKE_BAD_COUNT') == '1' else 0)",
      "with open(os.path.join(a.out_root,'eval_summary.json'),'w',encoding='utf-8') as f: json.dump({'hard':hard,'soft':hard,'n_items':count},f)",
    ].join("\n"),
    "utf8",
  )
  const skillPath = path.join(root, "skill.md")
  const evidenceRoot = path.join(root, "evidence")
  const authPath = path.join(root, "auth.json")
  const smokeCredential = "smoke-coding-plan-credential"
  await mkdir(evidenceRoot, { recursive: true })
  await writeTextFile(skillPath, "# Skill\n\nReusable procedure.\n")
  await writeJsonFile(authPath, {
    "minimax-cn-coding-plan": {
      type: "api",
      key: smokeCredential,
    },
  })
  const before = await treeDigest(fakeSkillOpt)
  const outDir = path.join(root, "aev-output")
  const result = await runSkillOptNativeEval({
    config: {
      enabled: true,
      projectRoot: fakeSkillOpt,
      configPath: "configs/officeqa/default.yaml",
      pythonCommand: "python",
      splitDir: "data/officeqa_id_split",
      dataDirs: [evidenceRoot],
      targetBackend: "minimax_chat",
      targetModel: "",
      targetBaseUrl: "",
      targetAuthFile: authPath,
      targetAuthProviderID: "minimax-cn-coding-plan",
      targetApiKeyEnv: "",
      reasoningEffort: "medium",
      workers: 2,
      timeoutMs: 60_000,
    },
    skillPath,
    split: "train",
    caseIDs: ["case-pass", "case-fail", "case-test-pass"],
    outDir,
    env: { SMOKE_REQUIRE_DATA_DIRS: "1", SMOKE_EXPECT_KEY: smokeCredential },
  })
  const after = await treeDigest(fakeSkillOpt)
  assert(before === after, "external SkillOpt project changed during native evaluation")
  assert(result.total === 3, `expected three cross-partition filtered cases, got ${result.total}`)
  assert(result.passed === 2 && result.failed === 1, "expected two passes and one fail")
  assert(result.regressions.join(",") === "case-fail", "expected failed case id in regressions")
  const filteredItems = JSON.parse(
    await readFile(path.join(outDir, "filtered-split", "train", "items.json"), "utf8"),
  ) as Array<{ id: string }>
  assert(
    filteredItems.map((item) => item.id).join(",") === "case-pass,case-fail,case-test-pass",
    "filtered target split must preserve requested UID order across source partitions",
  )
  assert((await stat(path.join(outDir, "native-output", "eval_summary.json"))).isFile(), "missing native summary")
  const launchText = await readFile(path.join(outDir, "launch.json"), "utf8")
  assert(!launchText.includes(smokeCredential), "launch metadata must not persist the provider credential")
  const baseInput = {
    config: {
      enabled: true,
      projectRoot: fakeSkillOpt,
      configPath: "configs/officeqa/default.yaml",
      pythonCommand: "python",
      splitDir: "data/officeqa_id_split",
      dataDirs: [evidenceRoot],
      targetBackend: "minimax_chat",
      targetModel: "",
      targetBaseUrl: "",
      targetAuthFile: "",
      targetAuthProviderID: "",
      targetApiKeyEnv: "",
      reasoningEffort: "medium",
      workers: 2,
      timeoutMs: 60_000,
    },
    skillPath,
    split: "train" as const,
    caseIDs: ["case-pass", "case-fail"],
  }
  let unexpectedIDFailed = false
  try {
    await runSkillOptNativeEval({
      ...baseInput,
      outDir: path.join(root, "unexpected-id-output"),
      env: { SMOKE_EXTRA_ID: "1" },
    })
  } catch (error) {
    unexpectedIDFailed = String(error).includes("unexpected case IDs")
  }
  assert(unexpectedIDFailed, "unexpected SkillOpt case IDs must fail closed")
  let badCountFailed = false
  try {
    await runSkillOptNativeEval({
      ...baseInput,
      outDir: path.join(root, "bad-count-output"),
      env: { SMOKE_BAD_COUNT: "1" },
    })
  } catch (error) {
    badCountFailed = String(error).includes("summary/results count mismatch")
  }
  assert(badCountFailed, "SkillOpt summary/results count mismatch must fail closed")
  let infrastructureFailedClosed = false
  try {
    await runSkillOptNativeEval({
      ...baseInput,
      outDir: path.join(root, "infrastructure-output"),
      env: { SMOKE_INFRA: "1" },
    })
  } catch (error) {
    infrastructureFailedClosed =
      String(error).includes("infrastructure-failed case") &&
      String(error).includes("refusing to treat them as product regressions")
  }
  assert(infrastructureFailedClosed, "SkillOpt infrastructure failures must fail closed before repair")
  console.log(
    JSON.stringify(
      {
        ok: true,
        sourceUnchanged: before === after,
        unexpectedIDFailed,
        badCountFailed,
        infrastructureFailedClosed,
        result,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
