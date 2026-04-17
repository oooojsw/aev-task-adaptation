const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")

const reportPath =
  "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/try4-expert-bootstrap/deployment/outputs/generated-report.docx"
const explanationPath =
  "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/try4-expert-bootstrap/deployment/outputs/generated-explanation.docx"
const extractDir =
  "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/try4-expert-bootstrap/deployment/work/verify_outputs"

function extractDocxText(docxPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true })
    }

    const psCode = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = '${docxPath.replace(/'/g, "''")}'
$dst = '${extractDir.replace(/'/g, "''")}'
[System.IO.Compression.ZipFile]::ExtractToDirectory($src, $dst)
Write-Host "Extracted"
`

    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCode], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    ps.on("close", (code) => {
      if (code === 0) {
        const xmlPath = path.join(extractDir, "word", "document.xml")
        const content = fs.readFileSync(xmlPath, "utf8")
        fs.rmSync(extractDir, { recursive: true })
        resolve(content)
      } else {
        reject(new Error("PowerShell exited with code " + code))
      }
    })
  })
}

async function main() {
  console.log("=== Deployment Validation (CORRECTED) ===\n")

  console.log("1. targets-exist check:")
  console.log("   report exists:", fs.existsSync(reportPath))
  console.log("   explanation exists:", fs.existsSync(explanationPath))
  console.log()

  console.log("2. placeholder-free check (【】 U+300A/B only, XXXX intentional):")
  try {
    const reportContent = await extractDocxText(reportPath)
    const explanationContent = await extractDocxText(explanationPath)

    const reportMatches = reportContent.match(/【[^】]*】/g) || []
    const explanationMatches = explanationContent.match(/【[^】]*】/g) || []

    console.log("   Report 【...】 placeholders:", reportMatches.length)
    if (reportMatches.length > 0) console.log("   Unique:", [...new Set(reportMatches)])
    console.log("   Explanation 【...】 placeholders:", explanationMatches.length)
    if (explanationMatches.length > 0) console.log("   Unique:", [...new Set(explanationMatches)])

    const u300aReport = (reportContent.match(/\u300a/g) || []).length
    const u300bReport = (reportContent.match(/\u300b/g) || []).length
    const u300aExp = (explanationContent.match(/\u300a/g) || []).length
    const u300bExp = (explanationContent.match(/\u300b/g) || []).length
    console.log("   U+300A (【) in report:", u300aReport, "explanation:", u300aExp)
    console.log("   U+300B (】) in report:", u300bReport, "explanation:", u300bExp)

    const placeholderFree =
      reportMatches.length === 0 &&
      explanationMatches.length === 0 &&
      u300aReport === 0 &&
      u300bReport === 0 &&
      u300aExp === 0 &&
      u300bExp === 0
    console.log("   placeholder-free PASS:", placeholderFree)
    console.log()

    console.log("3. reference-alignment check (CORRECTED):")
    console.log("   Source xlsx: AI26=20260 (评估值_不含税), AJ26=20665.2 (评估值_含税)")
    console.log()
    console.log("   Correct values that MUST be present:")
    console.log("   20260 in report:", reportContent.includes("20260"))
    console.log("   20260 in explanation:", explanationContent.includes("20260"))
    console.log("   20665.2 in report:", reportContent.includes("20665.2"))
    console.log("   20665.2 in explanation:", explanationContent.includes("20665.2"))
    console.log()
    console.log("   Wrong value 22893.8 (NOT in source xlsx):")
    console.log("   22893.8 in report:", reportContent.includes("22893.8"))
    console.log("   22893.8 in explanation:", explanationContent.includes("22893.8"))

    const correctInReport = reportContent.includes("20260") && reportContent.includes("20665.2")
    const correctInExp = explanationContent.includes("20260") && explanationContent.includes("20665.2")
    const wrongInReport = reportContent.includes("22893.8")
    const wrongInExp = explanationContent.includes("22893.8")
    const refPass = correctInReport && correctInExp && !wrongInReport && !wrongInExp
    console.log()
    console.log("   reference-alignment PASS:", refPass)
  } catch (err) {
    console.error("Error:", err.message)
  }

  console.log("\n=== END ===")
}

main()
