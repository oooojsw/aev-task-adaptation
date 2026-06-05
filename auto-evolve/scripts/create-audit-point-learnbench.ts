import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

interface Point {
  id: string
  title: string
  focus: string
  answer: string
  rule: string
}

const root = path.resolve(import.meta.dir, "..", "task-packs", "real-long-tasks", "audit-point-learnbench")
const source = path.resolve(import.meta.dir, "..", "task-packs", "real-long-tasks", "audit-report-pilot")

const points: Point[] = [
  {
    id: "audit-point-001",
    title: "法规依据位置与准则更新",
    focus: "检查报告中法规依据、取价依据和企业价值准则是否放置准确、版本是否更新。",
    answer: "法规依据 11、12 建议放在取价依据；企业价值准则需要更新。",
    rule: "遇到法规依据、取价依据、准则版本时，不只判断有无披露，还要检查位置是否属于正确章节，并核对准则是否为现行版本。",
  },
  {
    id: "audit-point-002",
    title: "境外存货盘点程序受限披露",
    focus: "检查子公司境外产品或存货盘点程序是否受限，是否需要特别事项披露。",
    answer: "子公司在产品，特别是国外的产品，如何履行盘点程序、是否存在程序受限，建议做特别事项披露说明。",
    rule: "涉及境外存货、在产品、无法现场盘点时，要追问盘点程序、限制原因和替代程序，必要时形成特别事项披露。",
  },
  {
    id: "audit-point-003",
    title: "P11 评估方法列与结论方法一致性",
    focus: "检查长期股权投资等表格中评估方法列是否与最终采用结论方法一致。",
    answer: "P11 评估方法列填写收益法更合理，因为选用收益法作为结论方法。",
    rule: "当一项资产或股权最终采用收益法结论时，要核对报告表格中的评估方法列是否同步写为收益法，避免资产基础法/收益法并列表述造成口径不一致。",
  },
  {
    id: "audit-point-004",
    title: "P12 其他应付款小标题重复",
    focus: "检查报告页码和科目标题，发现章节标题、小标题重复或层级异常。",
    answer: "P12（ 一）其他应付款小标题多余。",
    rule: "审核报告结构时，要检查页内标题层级和小标题是否重复、多余或与上下文科目不一致。",
  },
  {
    id: "audit-point-005",
    title: "P41 现场调查成新率计算依据",
    focus: "检查设备现场调查评分表是否能支撑成新率结论。",
    answer: "P41 现场调查评分表中设备外观、运行声音及震动、设备能耗合计评分为 90，但报告据此确定现场调查成新率为 93%，需要核实计算口径。",
    rule: "看到现场调查评分表时，要把各评分项合计和报告中的成新率结论逐项核对，分数与结论比例不一致时应要求说明或修正。",
  },
  {
    id: "audit-point-006",
    title: "P44 笔记本电脑名称核实",
    focus: "检查电子设备明细表中设备名称和页码引用是否需要核实。",
    answer: "P44 笔记本电脑（电子设备评估明细表第 122 项）名称需要核实。",
    rule: "对电子设备明细表中的具体设备项目，要抽查名称、规格、序号和报告引用是否一致，发现名称含糊或疑似错项时直接提出核实要求。",
  },
  {
    id: "audit-point-007",
    title: "P65 商标占比依据",
    focus: "检查无形资产收益分成中商标名称、商标占比和历史做法依据。",
    answer: "P65 注意修改为商标；另外商标的占比如何确定，商标以前是否也这样做，需要展开依据。",
    rule: "涉及商标、技术、客户关系等无形资产分成比例时，要检查资产名称是否准确、比例来源是否有可比公司或历史方法支撑。",
  },
  {
    id: "audit-point-008",
    title: "P67 商标收益期与无风险利率期限",
    focus: "检查商标收益期为无限期时，无风险利率期限选取是否匹配。",
    answer: "P67 5 年期国债收益率作为无风险收益率，但商标收益期是无限期，无风险利率需要取 10 年以上。",
    rule: "无形资产收益期若为长期或无限期，折现率中的无风险利率期限不能机械取短期国债，应匹配较长期限。",
  },
  {
    id: "audit-point-009",
    title: "P112 风险评价文字与表格一致性",
    focus: "检查个别风险评价体系文字、表格序号和合计值是否一致。",
    answer: "P112 下面文字部分分值与表格不一致，表格序号不连续，个别风险 Ru 计算过程需要核实。",
    rule: "风险评价表要同时核对文字描述、表格序号、权重、风险值和加权风险值，序号跳号或文字/表格不一致都应列为审核意见。",
  },
  {
    id: "audit-point-010",
    title: "P115 境外收入增长率依据",
    focus: "检查预测期国内外收入增长率，特别是高增长假设是否有分析支撑。",
    answer: "P115 2025 年以后国内业务增长率预计 3%-8%，国外业务增长率预计 3%-50%；国外 2025 年收入增长率 50% 的依据需要展开分析。",
    rule: "预测期收入增长率出现显著高值时，要要求提供订单、客户、市场或历史数据支撑，不能只接受管理层预测数字。",
  },
  {
    id: "audit-point-011",
    title: "无形资产技术占比与底稿不一致",
    focus: "检查无形资产计算表和底稿之间关键比例是否一致。",
    answer: "无形资产计算表中“无形非流动资产中技术所占比例”取值 20%，与底稿中的 40% 不一致，请核实或完善底稿。",
    rule: "报告、计算表和底稿之间的关键比例必须交叉核对；技术、商标等无形资产占比不一致时，应要求统一口径或补充依据。",
  },
  {
    id: "audit-point-012",
    title: "折旧摊销表合计与成本费用勾稽",
    focus: "检查折旧摊销表每年合计数与成本费用中合计数是否一致。",
    answer: "折旧摊销表中每年合计数与成本费用中合计数是否一致，需要自行核实，建议做一个检查勾稽项。",
    rule: "遇到折旧摊销预测，要把折旧摊销表年度合计与成本费用表对应合计做勾稽，并把勾稽关系写成明确检查项。",
  },
  {
    id: "audit-point-013",
    title: "ADJ 表 H10 与 H83 不等",
    focus: "检查调整表内相互引用单元格是否一致。",
    answer: "ADJ 表 H10 与 H83 不等，是否恰当需要核实。",
    rule: "对调整表、合并口径表等底稿，要检查同一口径的引用单元格是否相等，不相等时不能泛泛提示，要点名单元格。",
  },
  {
    id: "audit-point-014",
    title: "坏账准备调整与成本法处理不一致",
    focus: "检查 ADJ 表坏账准备调整、成本法处理、递延所得税资产之间是否衔接。",
    answer: "ADJ 表中应收账款坏账准备 H13 全额调整与成本法处理不一致，并且与递延所得税资产数据是否衔接需要核实；H24 的调整也与成本法不一致。",
    rule: "坏账准备、成本法和递延所得税资产之间存在联动，审核时要同时检查调整金额、成本法处理和税务影响是否一致。",
  },
  {
    id: "audit-point-015",
    title: "资本性支出直升机更新",
    focus: "检查资本性支出计划中重大设备是否需要更新或补充依据。",
    answer: "资本性支出中直升机是否需要更新，需要核实。",
    rule: "资本性支出预测中出现重大设备、车辆、飞机等资产时，要检查是否存在更新计划、更新金额和预测期匹配依据。",
  },
  {
    id: "audit-point-016",
    title: "建筑物表 AG9 内容清除",
    focus: "检查建筑物表中不应保留的内容或对应项是否清除。",
    answer: "建筑物表 AG9 内容需要清除；答复称已清除明细表对应项。",
    rule: "表格中被标注需删除或清除的内容，要回查明细表对应单元格是否已经真正清除，不能只看答复文字。",
  },
  {
    id: "audit-point-017",
    title: "应收票据坏账损失处理逻辑",
    focus: "检查应收票据坏账损失是否过于谨慎，出票方信用判断是否合理。",
    answer: "应收票据坏账损失处理逻辑值得商榷；是否预计损失主要应判断出票方信用，同一出票方部分月份已到期收回，部分月份预计损失可能过于谨慎。",
    rule: "应收票据坏账判断不能只按月份机械计提，要结合出票方信用、到期后收回记录和同一出票方历史回款情况。",
  },
  {
    id: "audit-point-018",
    title: "其他应收款票据类型影响",
    focus: "检查其他应收款中开具专票或普票对评估值是否有影响。",
    answer: "其他应收款第 4 项开具的是专票还是普票，如果是普票，评估值是否恰当需要核实。",
    rule: "其他应收款或往来款涉及发票类型时，要核对专票/普票差异是否影响税额、可抵扣性和评估值。",
  },
  {
    id: "audit-point-019",
    title: "P26 房屋耐用年限与土地剩余年限",
    focus: "检查房屋建筑物耐用年限、已使用年限、尚可使用年限和土地剩余年限是否匹配。",
    answer: "P26 估计该房屋建筑物耐用年限为 50 年，至基准日已使用 8.33 年，尚可使用 41.67 年，但土地剩余年限只有 34 年。",
    rule: "房屋建筑物尚可使用年限不能孤立看建筑耐用年限，还要与土地剩余年限、权属期限和实际使用限制做匹配。",
  },
  {
    id: "audit-point-020",
    title: "资金成本上浮 100 基点",
    focus: "检查贷款市场报价利率和资金成本上浮基点是否合理。",
    answer: "鉴于目前银行贷款市场现状，计算资金成本时上浮 100 个基点是否合适需要核实；答复称实际按评估基准日 LPR 确定贷款利率并删除上浮 100 个基点描述。",
    rule: "资金成本测算要核对 LPR、上浮基点和报告描述是否一致；如果没有依据，不应保留机械上浮 100 个基点的表述。",
  },
  {
    id: "audit-point-021",
    title: "P16 法国 PPI 与重置全价公式核实",
    focus: "检查法国电气、电子及数据处理设备 PPI 基准日、购买日数据和重置全价计算公式是否正确。",
    answer:
      "P16 经查询法国电气、电子及数据处理设备 PPI 在评估基准日 2023 年 9 月为 114.10，在购买日 2024 年 4 月为 113.90，则重置全价=1,591.63/100×773.22×114.10/113.90=12,300.00 元（取整）。上述基准日及 PPI 数据需核实。",
    rule: "境外设备重置全价使用 PPI 调整时，要核对基准日指数、购买日指数、原币金额、汇率或换算因子和取整结果，公式链条任一处无来源都应提出核实。",
  },
  {
    id: "audit-point-022",
    title: "购买 1 个月设备是否调整重置全价",
    focus: "检查购买时间距离评估基准日很近的设备，是否仍需要进行 PPI 或重置全价调整。",
    answer: "购买 1 个月的设备是否需要调整重置全价需要核实。",
    rule: "设备购买日距离评估基准日很近时，要判断价格变动调整是否有必要，避免机械套用 PPI 造成不合理重置全价。",
  },
  {
    id: "audit-point-023",
    title: "三年以上电脑重置价高于购买价",
    focus: "检查使用年限较长的电脑等电子设备，重置价是否异常高于购买价。",
    answer: "部分 3 年以上电脑重置价高于购买价是否正确需要核实。",
    rule: "电子设备尤其是电脑类资产通常更新迭代快、价格下降明显，若旧设备重置价高于购买价，应检查型号、购置价、重置价来源和调整公式是否合理。",
  },
  {
    id: "audit-point-024",
    title: "合同负债表页脚评估人员完善",
    focus: "检查合同负债表等明细表页脚、评估人员、复核人员等签署或填列信息是否完整。",
    answer: "合同负债表页脚评估人员需完善。",
    rule: "审核明细表时除了金额，还要检查页脚、编制人、评估人员、复核人等必要信息是否完整，缺失时应作为格式完整性审核意见提出。",
  },
  {
    id: "audit-point-025",
    title: "流动负债汇总表页脚完善",
    focus: "检查浙江海可姆相关流动负债汇总表页脚、评估人员等基础信息是否完整。",
    answer: "浙江海可姆流动负债汇总表页脚需完善。",
    rule: "子公司或分部明细表的页脚签署信息需要逐表检查，不能只检查母公司或主表；页脚缺失应指出具体公司和表名。",
  },
  {
    id: "audit-point-026",
    title: "P12 分布于于公司各部门文字错误",
    focus: "检查上海公司报告正文中是否存在明显重复用字、错别字或表述不通顺。",
    answer: "上海公司 P12 “分布于于公司各部门”文字表述需要修正。",
    rule: "报告正文审核要检查明显错别字、重复字和病句；发现具体错误时应引用页码和原句，提出明确文字修正。",
  },
  {
    id: "audit-point-027",
    title: "P14 案例 1 笔记本电脑第 25 项核实",
    focus: "检查上海公司 P14 案例 1 中笔记本电脑项目与电子设备评估明细表第 25 项是否一致、是否需核实。",
    answer: "上海公司 P14 案例 1：笔记本电脑（电子设备评估明细表第 25 项）需核实。",
    rule: "案例说明引用具体设备时，要回到电子设备评估明细表核对序号、名称、型号和价值，发现案例与明细不清或不一致时应要求核实。",
  },
  {
    id: "audit-point-028",
    title: "五年以上电脑二手价建议",
    focus: "检查使用 5 年以上电脑类电子设备是否仍按重置成本法机械评估，是否应考虑二手价。",
    answer: "5 年以上的电脑建议直接用二手价。",
    rule: "对使用年限较长、技术淘汰快的电脑类电子设备，要评估重置成本法是否适用；超过 5 年的电脑可优先考虑二手市场价格或可变现价值。",
  },
]

function spec(point: Point) {
  return {
    id: point.id,
    title: point.id,
    goal: `Learn a reusable expert skill for finding and writing one professional internal audit opinion: ${point.title}. The final blank agent should produce exactly one audit opinion item, not a full report.`,
    taskFamily: "audit-point-learnbench",
    domainTags: ["audit-point-generation", "asset-valuation", "soft-validation"],
    materials: [
      { path: "../../../audit-report-pilot/materials/定稿", label: "shared finalized valuation deliverables", role: "source-artifact" },
      { path: "../../../audit-report-pilot/materials/电子底稿", label: "shared working papers", role: "source-artifact" },
    ],
    targetPaths: [{ path: "./expert-workspace", label: "learned audit-point skill", role: "experience-workspace" }],
    editablePaths: ["./expert-workspace", "./workspace"],
    initialExpertContextPaths: ["../../seed-expert-workspace/manifest.md", "../../seed-expert-workspace/change_log.md"],
    formalPackageRoots: ["./expert-workspace"],
    validatorProfiles: ["audit-point/single-train-v2"],
    blankEvalValidatorProfiles: ["audit-point/blank-eval-targeted-v2"],
    validators: [],
    planning: { agent: "top" },
    execution: { agent: "top" },
    validation: { agent: "top" },
    initialGraph: {
      planner_summary: "Single-point audit learnbench: inspect all shared valuation materials, learn one reusable audit finding pattern, and write a one-point audit output for soft validation.",
      completion_validator_ids: ["workspace-layout", "single-point-soft-validate"],
      units: [
        {
          id: "inspect-shared-materials",
          title: "Inspect Shared Materials",
          goal: `Inspect the shared valuation report and working papers for evidence related to this audit finding type: ${point.focus} Do not write a full audit report.`,
          inputs: ["../../../audit-report-pilot/materials/定稿", "../../../audit-report-pilot/materials/电子底稿"],
          depends_on: [],
          expected_artifacts: ["./workspace/material-notes.md"],
          claim: "Relevant evidence and checking targets for this one audit issue type have been identified.",
          check_plan: "Write concise material notes with exact pages, sheets, rows, cells, or report sections where possible.",
          validator_ids: [],
          retry_budget: 2,
        },
        {
          id: "write-single-point-skill-and-output",
          title: "Write Single Point Skill And Output",
          goal: "Create a reusable skill package that teaches the finding pattern, and write workspace/audit-point-output.md containing exactly one professional audit opinion item.",
          inputs: ["./workspace/material-notes.md", "../../seed-expert-workspace/manifest.md"],
          depends_on: ["inspect-shared-materials"],
          expected_artifacts: ["./expert-workspace/manifest.md", "./expert-workspace/change_log.md", "./workspace/audit-point-output.md"],
          claim: "The skill and one-point audit output are complete.",
          check_plan: "The output must be one actionable audit opinion item with evidence, issue, and requested correction/check.",
          validator_ids: [],
          retry_budget: 2,
        },
      ],
    },
    budgets: {
      maxAttemptsPerUnit: 3,
      maxTotalUnitAttempts: 8,
      maxGraphReplans: 2,
      maxValidatorCalls: 10,
      maxNoProgressCycles: 3,
      maxUnitsPerGraph: 5,
    },
    shadowMemoryScope: { namespace: "audit-point-learnbench", tags: ["audit-point-generation"], retrievalMode: "manual" },
    notes: "One instance learns exactly one audit finding pattern. Shared material directories are visible read-only inputs; do not copy or edit them. The answer file is used only by the soft validator.",
  }
}

function campaign(point: Point) {
  return {
    title: `audit-point-learnbench-campaign-${point.id}`,
    taskFamily: "audit-point-learnbench",
    mode: "graph_iterative",
    baseSpecPath: "./spec.json",
    maxRounds: 20,
    seedTargets: [
      {
        targetPath: "./expert-workspace",
        seedPath: "../../seed-expert-workspace",
        kind: "experience_workspace",
        resetOnStart: true,
      },
    ],
    lessonsMirror: {
      workspaceTargetPath: "./expert-workspace",
      relativePath: "lessons/failure_lessons.md",
      addManifestPointer: true,
    },
    carryover: {
      includeFailurePackets: true,
      includeRetryLessons: true,
      includeLearningUnits: true,
      includeRoundSummaries: true,
      recentRoundSummaryCount: 5,
    },
    surfaceGeneralization: {
      enabled: true,
      validatorPath: "../../../../../scripts/validate-experience-surface-generalization.py",
      configPath: "../../configs/single-surface-generalization.json",
      blocking: false,
      timeoutMs: 60000,
    },
    roundBudgetOverrides: {
      maxAttemptsPerUnit: 3,
      maxTotalUnitAttempts: 8,
      maxGraphReplans: 2,
      maxValidatorCalls: 10,
      maxNoProgressCycles: 3,
      maxUnitsPerGraph: 5,
    },
  }
}

async function main() {
  await mkdir(path.join(root, "tasks"), { recursive: true })
  await mkdir(path.join(root, "seed-expert-workspace"), { recursive: true })
  await mkdir(path.join(root, "configs"), { recursive: true })
  await writeFile(
    path.join(root, "README.md"),
    [
      "# audit-point-learnbench",
      "",
      "This dataset splits the original audit-report-pilot task into single audit finding instances.",
      "All instances read the same full valuation material directories from audit-report-pilot.",
      "The shared material directories are read-only inputs. Do not copy them and do not grant edit access to them.",
      "Each instance has a different hidden answer under answer/answer.md and a soft validator for exactly one audit point.",
      "",
      "- train instances: audit-point-001 to audit-point-020",
      "- test instances: audit-point-021 to audit-point-028",
      "- intended fanout: 5 concurrent campaigns",
      "- intended output per instance: one reusable skill plus workspace/audit-point-output.md",
      "- writable paths per instance: only its own workspace/ and expert-workspace/",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    path.join(root, "seed-expert-workspace", "manifest.md"),
    [
      "# Audit Point Seed Expert Workspace",
      "",
      "Learn reusable audit finding patterns. Do not memorize one case answer as a fixed script.",
      "",
      "For each finding, derive a general rule:",
      "- what source documents or worksheets to inspect",
      "- what consistency relation to check",
      "- what specific evidence to cite",
      "- how to write one actionable audit opinion item",
    ].join("\n"),
    "utf8",
  )
  await writeFile(path.join(root, "seed-expert-workspace", "change_log.md"), "# Change Log\n\nSeed workspace.\n", "utf8")
  const surfaceBase = {
    rootPaths: ["./expert-workspace"],
    allowedExtensions: [".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".py", ".ps1", ".sh", ".js", ".mjs", ".cjs", ".ts"],
    ignorePathSubstrings: ["/tools/", "/skills/", "node_modules", ".git", "__pycache__"],
    warnOnIgnoredHits: false,
    maxHitsPerFile: 6,
    maxTotalHits: 30,
    forbiddenPatterns: [
      { label: "task-id-hardcode", pattern: "audit-point-\\d+" },
      { label: "hidden-answer-section-copy", pattern: "##\\s*Hidden\\s*Expert\\s*Answer" },
      { label: "answer-literal-leak", pattern: "(?i)hidden\\s*answer|ground\\s*truth|official\\s*answer" },
    ],
    forbiddenLiterals: [],
    requiredSections: [
      {
        file: "CORE.md",
        sections: [
          "## Material Navigation Rules",
          "## High-Value Anomaly Patterns",
          "## Evidence Localization Workflow",
          "## Audit Opinion Writing Template",
          "## Failure Lessons And Anti-Patterns",
          "## Optional Observations",
        ],
      },
    ],
  }
  const singleSurface = {
    ...surfaceBase,
    requiredFiles: [
      "INDEX.md",
      "CORE.md",
      "meta.json",
      "surface_contract.json",
      "open_observations.md",
      "case.md",
      "lessons/failure_lessons.md",
    ],
  }
  const mergedSurface = {
    ...surfaceBase,
    requiredFiles: [
      "INDEX.md",
      "CORE.md",
      "meta.json",
      "surface_contract.json",
      "open_observations.md",
      "patches/training-backtest-patches.md",
      "patches/patch-log.jsonl",
    ],
    requiredDirs: ["casebook"],
  }
  await writeFile(
    path.join(root, "configs", "single-surface-generalization.json"),
    JSON.stringify(singleSurface, null, 2) + "\n",
    "utf8",
  )
  await writeFile(
    path.join(root, "configs", "merged-surface-generalization.json"),
    JSON.stringify(mergedSurface, null, 2) + "\n",
    "utf8",
  )
  await writeFile(
    path.join(root, "configs", "surface-generalization.json"),
    JSON.stringify(mergedSurface, null, 2) + "\n",
    "utf8",
  )

  for (const point of points) {
    const dir = path.join(root, "tasks", point.id)
    await mkdir(path.join(dir, "answer"), { recursive: true })
    await mkdir(path.join(dir, "workspace"), { recursive: true })
    await mkdir(path.join(dir, "expert-workspace"), { recursive: true })
    await writeFile(path.join(dir, "spec.json"), JSON.stringify(spec(point), null, 2), "utf8")
    await writeFile(path.join(dir, "campaign.json"), JSON.stringify(campaign(point), null, 2), "utf8")
    await writeFile(
      path.join(dir, "answer", "answer.md"),
      [
        `# ${point.id}: ${point.title}`,
        "",
        "## Focus",
        point.focus,
        "",
        "## Hidden Expert Answer",
        point.answer,
        "",
        "## Generalizable Rule",
        point.rule,
      ].join("\n"),
      "utf8",
    )
    await writeFile(
      path.join(dir, "human-guidance.md"),
      [
        `# ${point.id} Human Guidance`,
        "",
        "This file is human-authored background guidance for one audit-point task.",
        "It is not the validator's primary task.",
        "",
        "Hard constraints:",
        "1. The task output should contain exactly one audit opinion item in workspace/audit-point-output.md.",
        "2. The item should include issue statement, concrete evidence, and actionable requested correction/check.",
        "3. Do not expand into a full report.",
      ].join("\n"),
      "utf8",
    )
  }

  await writeFile(
    path.join(root, "train-instances.json"),
    JSON.stringify(
      {
        dataset: "audit-point-learnbench",
        split: "train",
        count: points.slice(0, 20).length,
        instances: points.slice(0, 20).map((point) => ({
          id: point.id,
          specPath: `tasks/${point.id}/spec.json`,
          campaignPath: `tasks/${point.id}/campaign.json`,
          answerPath: `tasks/${point.id}/answer/answer.md`,
        })),
      },
      null,
      2,
    ),
    "utf8",
  )
  await writeFile(
    path.join(root, "test-instances.json"),
    JSON.stringify(
      {
        dataset: "audit-point-learnbench",
        source: "audit-report-pilot-human-review-28",
        split: "test",
        count: points.slice(20).length,
        instances: points.slice(20).map((point, index) => ({
          id: point.id,
          originAuditPointIndex: index + 21,
          mode: "reproduce",
          specPath: `tasks/${point.id}/spec.json`,
          campaignPath: `tasks/${point.id}/campaign.json`,
          answerPath: `tasks/${point.id}/answer/answer.md`,
        })),
        groups: [
          {
            name: "reproduce",
            description: "targeted-blind holdout: hidden answers are not available to the solving agent",
            instanceIDs: points.slice(20).map((point) => point.id),
          },
          {
            name: "discovery",
            description: "deferred; current materials do not support open-discovery evaluation",
            instanceIDs: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  )
}

main()
