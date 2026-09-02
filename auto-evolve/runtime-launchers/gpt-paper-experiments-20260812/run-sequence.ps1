param(
  [string]$BaseUrl = "http://localhost:63384/v1",
  [ValidateRange(1, 8)][int]$SpreadsheetWorkers = 2,
  [ValidateRange(1, 8)][int]$OfficeWorkers = 2
)

$ErrorActionPreference = "Stop"
$root = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$skillOpt = "C:\Users\ZhuanZ\Desktop\SkillOpt"
$python = "C:\Users\ZhuanZ\miniconda3\python.exe"
$launcher = Join-Path $root "auto-evolve\runtime-launchers\gpt-paper-experiments-20260812"
$sequence = Join-Path $root "auto-evolve\runtime-state\experiment-sequences\20260812-gpt-paper-experiments-1-to-4"
$statusPath = Join-Path $sequence "status.json"
$ledgerTool = Join-Path $launcher "experiment_ledger.py"

New-Item -ItemType Directory -Force -Path $sequence | Out-Null

if ([string]::IsNullOrWhiteSpace($env:QWEN_CHAT_API_KEY)) {
  $configPath = "C:\Users\ZhuanZ\.antigravity_cockpit\codex_local_access_sidecar\config.json"
  $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
  $keys = @($config.'api-keys')
  if ($keys.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$keys[0])) {
    throw "The local 63384 service config has no usable API key."
  }
  $env:QWEN_CHAT_API_KEY = [string]$keys[0]
}
$env:QWEN_CHAT_BASE_URL = $BaseUrl
$env:QWEN_CHAT_ENABLE_THINKING = "false"

$empty = Join-Path $skillOpt "empty-no-skill.md"
$sheetOld = Join-Path $skillOpt "outputs\spreadsheetbench-aev-merged-skill-20260720.md"
$sheetOfficial = Join-Path $skillOpt "ckpt\spreadsheetbench\gpt5.5_skill.md"
$sheetOldOpt = Join-Path $root "auto-evolve\runtime-state\benchmark-runs\20260804-spreadsheetbench69-merge-as-opt-minimax27\merge-and-validate\phase2-skillopt\native-train\best_skill.md"
$sheetNewOpt = Join-Path $root "auto-evolve\runtime-state\benchmark-runs\20260811-spreadsheetbench69-merge-as-opt-minimax27-repeat-01\merge-and-validate\phase2-skillopt\native-train\best_skill.md"
$officeOld = Join-Path $root "auto-evolve\runtime-state\direct-chat-runs\20260621-210016-officeqa172-gpt54mini-with-final-skill-full-c3-retry1\direct-chat-skill.full.md"
$officeOpt = Join-Path $root "auto-evolve\runtime-state\benchmark-runs\20260722-230100-officeqa40-merge-as-opt-native-minimax27\merge-and-validate\phase2-skillopt\native-train-fixed-20260726\best_skill.md"

$jobs = [System.Collections.Generic.List[object]]::new()
function Add-SheetJob($id, $model, $skill, $out, $source = "", $drop = "", $category = "") {
  $jobs.Add([ordered]@{id=$id; dataset="spreadsheetbench"; model=$model; skill=$skill; out=$out; expected=280; source=$source; drop=$drop; category=$category})
}
function Add-OfficeJob($id, $skill, $out, $category) {
  $jobs.Add([ordered]@{id=$id; dataset="officeqa"; model="gpt-5.5"; skill=$skill; out=$out; expected=172; source=""; drop=""; category=$category})
}

$unified = Join-Path $skillOpt "outputs\spreadsheetbench-unified280-20260812"
$miniDrop = "516-46,60-7,283-32,53161"
$gpt54Drop = "60-7,283-32"
$patchSpecs = @(
  @("noskill", $empty, "spreadsheetbench-gpt54mini-noskill-20260720"),
  @("mergeold", $sheetOld, "spreadsheetbench-gpt54mini-aev-merged-skill-20260720"),
  @("optminimax", (Join-Path $skillOpt "outputs\spreadsheetbench-optminimax-m27-training-20260719-140245\best_skill.md"), "spreadsheetbench-gpt54mini-optminimax-m27-skill-20260721"),
  @("mergeopt", $sheetOldOpt, "spreadsheetbench-gpt54mini-mergeopt-63384-20260809"),
  @("official", $sheetOfficial, "spreadsheetbench-gpt54mini-skillopt-official-skill-20260721")
)
foreach ($spec in $patchSpecs) {
  Add-SheetJob "unified-gpt54mini-$($spec[0])" "gpt-5.4-mini" $spec[1] (Join-Path $unified "gpt54mini-$($spec[0])") (Join-Path $skillOpt "outputs\$($spec[2])") $miniDrop "unified280"
}
$patchSpecs54 = @(
  @("noskill", $empty, "spreadsheetbench-gpt54-noskill-63384-20260722"),
  @("mergeold", $sheetOld, "spreadsheetbench-gpt54-aev-minimax-m27-skill-63384-20260722"),
  @("optminimax", (Join-Path $skillOpt "outputs\spreadsheetbench-optminimax-m27-training-20260719-140245\best_skill.md"), "spreadsheetbench-gpt54-optminimax-m27-skill-63384-20260722"),
  @("mergeopt", $sheetOldOpt, "spreadsheetbench-gpt54-mergeopt-63384-20260809"),
  @("official", $sheetOfficial, "spreadsheetbench-gpt54-skillopt-official-gpt55-skill-63384-20260722")
)
foreach ($spec in $patchSpecs54) {
  Add-SheetJob "unified-gpt54-$($spec[0])" "gpt-5.4" $spec[1] (Join-Path $unified "gpt54-$($spec[0])") (Join-Path $skillOpt "outputs\$($spec[2])") $gpt54Drop "unified280"
}

$newRoot = Join-Path $skillOpt "outputs\spreadsheetbench-repeat01-mergeopt-gpt-eval-20260812"
foreach ($model in @("gpt-5.4-mini", "gpt-5.4", "gpt-5.5")) {
  Add-SheetJob "repeat01-$model" $model $sheetNewOpt (Join-Path $newRoot ($model -replace '\.','')) "" "" "repeat01"
}

$stability = Join-Path $skillOpt "outputs\gpt55-stability-repeats-20260812"
for ($repeat = 1; $repeat -le 2; $repeat++) {
  Add-OfficeJob "office-r$repeat-noskill" $empty (Join-Path $stability "officeqa\repeat-$repeat\noskill") "stability"
  Add-OfficeJob "office-r$repeat-mergeold" $officeOld (Join-Path $stability "officeqa\repeat-$repeat\merge-as-old") "stability"
  Add-OfficeJob "office-r$repeat-mergeopt" $officeOpt (Join-Path $stability "officeqa\repeat-$repeat\merge-as-opt") "stability"
}
for ($repeat = 1; $repeat -le 2; $repeat++) {
  Add-SheetJob "sheet-r$repeat-noskill" "gpt-5.5" $empty (Join-Path $stability "spreadsheetbench\repeat-$repeat\noskill") "" "" "stability"
  Add-SheetJob "sheet-r$repeat-mergeold" "gpt-5.5" $sheetOld (Join-Path $stability "spreadsheetbench\repeat-$repeat\merge-as-old") "" "" "stability"
  Add-SheetJob "sheet-r$repeat-mergeopt" "gpt-5.5" $sheetOldOpt (Join-Path $stability "spreadsheetbench\repeat-$repeat\merge-as-opt") "" "" "stability"
}

function Get-Audit($job) {
  $path = Join-Path $job.out "results.jsonl"
  if (-not (Test-Path -LiteralPath $path)) { return [ordered]@{rows=0; uniqueIds=0; expected=$job.expected; complete=$false; infraIds=@(); duplicateIds=@(); hardPasses=0; softSum=0} }
  return (& $python $ledgerTool audit --path $path --expected $job.expected | ConvertFrom-Json)
}

function Write-Status($state, $active, $message) {
  $items = foreach ($job in $jobs) {
    $audit = Get-Audit $job
    [ordered]@{id=$job.id; dataset=$job.dataset; model=$job.model; category=$job.category; rows=$audit.rows; uniqueIds=$audit.uniqueIds; expected=$job.expected; infra=@($audit.infraIds).Count; complete=[bool]$audit.complete -and @($audit.infraIds).Count -eq 0; out=$job.out}
  }
  $payload = [ordered]@{updatedAt=(Get-Date).ToString("o"); state=$state; activeJob=$active; message=$message; baseUrl=$BaseUrl; jobs=$items}
  $temp = "$statusPath.tmp"
  [IO.File]::WriteAllText($temp, ($payload | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -Force -LiteralPath $temp -Destination $statusPath
}

function Invoke-Eval($job) {
  New-Item -ItemType Directory -Force -Path $job.out | Out-Null
  $args = [System.Collections.Generic.List[string]]::new()
  $args.AddRange([string[]]@("-u", "scripts/eval_only.py"))
  if ($job.dataset -eq "spreadsheetbench") {
    $args.AddRange([string[]]@("--config", "configs/spreadsheetbench/default.yaml", "--skill", $job.skill, "--split", "test", "--backend", "qwen_chat", "--target_model", $job.model, "--target_backend", "qwen_chat", "--qwen_chat_base_url", $BaseUrl, "--qwen_chat_enable_thinking", "false", "--split_dir", "data/spreadsheetbench_split", "--data_root", "E:/project/experiment/SpreadsheetBench/all_data_912_v0.1", "--out_root", $job.out, "--mode", "multi", "--max_turns", "30", "--workers", [string]$SpreadsheetWorkers, "--cfg-options", "env.exec_timeout=1200"))
  } else {
    $args.AddRange([string[]]@("--config", "configs/officeqa/local-official-corpus.yaml", "--skill", $job.skill, "--split", "valid_unseen", "--split_dir", "data/officeqa_id_split", "--backend", "qwen_chat", "--target_backend", "qwen_chat", "--optimizer_backend", "openai_chat", "--target_model", "gpt-5.5", "--optimizer_model", "gpt-5.5", "--reasoning_effort", "medium", "--qwen_chat_base_url", $BaseUrl, "--qwen_chat_enable_thinking", "false", "--workers", [string]$OfficeWorkers, "--out_root", $job.out, "--cfg-options", "env.use_local_tools=false", "env.max_tool_turns=1", "env.max_completion_tokens=16384"))
  }
  $fingerprint = & $python $ledgerTool fingerprint --path $job.skill | ConvertFrom-Json
  $meta = [ordered]@{startedAt=(Get-Date).ToString("o"); id=$job.id; dataset=$job.dataset; model=$job.model; category=$job.category; expected=$job.expected; skillPath=$fingerprint.path; skillBytes=$fingerprint.bytes; skillSha256=$fingerprint.sha256; baseUrl=$BaseUrl; spreadsheetWorkers=$SpreadsheetWorkers; officeWorkers=$OfficeWorkers; taskTimeoutSeconds=$(if($job.dataset -eq "spreadsheetbench"){1200}else{0}); mode=$(if($job.dataset -eq "spreadsheetbench"){"SkillOpt-native-multi-max30"}else{"SkillOpt-native-singleturn-no-tools-oracle-pages"})}
  [IO.File]::WriteAllText((Join-Path $job.out "launch-meta.json"), ($meta | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  & $python @args 1>> (Join-Path $job.out "stdout.log") 2>> (Join-Path $job.out "stderr.log")
  $code = $LASTEXITCODE; $ErrorActionPreference = $old
  [IO.File]::WriteAllText((Join-Path $job.out "exit-code.txt"), [string]$code, [Text.UTF8Encoding]::new($false))
  return $code
}

try {
  Write-Status "running" "" "Sequence started or resumed."
  foreach ($job in $jobs) {
    foreach ($required in @($job.skill)) { if (-not (Test-Path -LiteralPath $required)) { throw "Required file missing: $required" } }
    $ledger = Join-Path $job.out "results.jsonl"
    if ($job.source -and -not (Test-Path -LiteralPath $ledger)) {
      New-Item -ItemType Directory -Force -Path $job.out | Out-Null
      & $python $ledgerTool seed --source (Join-Path $job.source "results.jsonl") --target $ledger --drop $job.drop | Out-File -Encoding utf8 (Join-Path $job.out "seed-report.json")
    }
    $audit = Get-Audit $job
    if ($audit.complete -and @($audit.infraIds).Count -eq 0) { continue }
    Write-Status "running" $job.id "Evaluator active."
    $jobComplete = $false
    for ($attempt = 1; $attempt -le 6; $attempt++) {
      $code = Invoke-Eval $job
      $audit = Get-Audit $job
      if (@($audit.infraIds).Count -gt 0) {
        & $python $ledgerTool drop-infra --path $ledger | Out-File -Append -Encoding utf8 (Join-Path $job.out "infra-retries.jsonl")
        $archives = @(Get-ChildItem -File (Join-Path $job.out "infrastructure-archive") -ErrorAction SilentlyContinue)
        if ($job.category -eq "unified280" -and $job.source -and $archives.Count -ge 2) {
          $sourceLedger = Join-Path $job.source "results.jsonl"
          foreach ($infraID in @($audit.infraIds)) {
            try {
              & $python $ledgerTool restore-uid --source $sourceLedger --target $ledger --uid $infraID --reason "Two clean-run infrastructure retries failed; reused the same model, skill, UID, and evaluation-mode historical non-infrastructure result." | Out-File -Append -Encoding utf8 (Join-Path $job.out "historical-evidence-reuse.jsonl")
            } catch {
              # Source rows that are absent or infrastructure-failed remain pending.
            }
          }
        }
        continue
      }
      if ($code -eq 0 -and $audit.complete -and @($audit.duplicateIds).Count -eq 0) {
        $jobComplete = $true
        break
      }
    }
    if (-not $jobComplete) {
      throw "Job $($job.id) did not reach a clean complete state after six infrastructure retries."
    }
    Write-Status "running" $job.id "Evaluator completed and audited."
  }
  Write-Status "complete" "" "All requested experiments 1-4 completed."
  [IO.File]::WriteAllText((Join-Path $sequence "exit-code.txt"), "0", [Text.UTF8Encoding]::new($false))
} catch {
  Write-Status "failed" "" $_.Exception.Message
  [IO.File]::WriteAllText((Join-Path $sequence "exit-code.txt"), "1", [Text.UTF8Encoding]::new($false))
  throw
}
