# Worker职责审计与三Worker并行配置

## 当前状态

原50份来源合并任务已由1名分析Worker调整为3名并行分析Worker。原Campaign、当前第8轮、最大20轮、候选、材料、评分协议及消耗账本均保留。本次只有离线准备和测试，真实模型请求0，未恢复训练。不是新增Codex子Agent。

Run：`E:/project/AEV-50skill-consolidation-20261021`。

Campaign：`E:/project/aev-task-adaptation/auto-evolve/runtime-state/long-task-campaigns/20261021-132545027-621b3f1e-merge-all-50-frozen-source-skills-success-and-fa`。

## 为什么Worker输出完整Skill

实际提示见Campaign下`rounds/round-008/workers/task-sources/prompt.txt`，关键原文如下（省略号表示摘录）：

```text
You are the worker for an AEV skill task. Stage: explore.
Task objective: Merge all 50 frozen source Skills ... into one reusable DIRECT_CHAT.md...
Analysis purpose: Analyze all frozen sources, source statuses, training answers and formal feedback for general reusable rules. Avoid memorized answers.
Produce reusable guidance; do not copy instance-specific private answers into the Skill.
Return your complete final analysis for the Lead as ordinary text or Markdown, not a JSON schema.
```

新适配入口重新组装提示，不使用旧Worker提示。旧提示明确要求`You are not the final campaign author`和`Do not rewrite the pending expert package directly`，新提示缺少同等边界。共享全局合并目标和“Produce reusable guidance”容易让Worker承担最终作者职责。这是提示缺口，不是已经证明模型所有输出的唯一原因。

实际权限只有read，没有write。已见行为是在最终回答中提供完整替代Skill，不是Worker物理改写候选文件。当前只有1名，是task.json显式声明了1名，不是框架只能支持1名；maxWorkers只是上限。

独立输出膨胀问题：正常stop的完整回答仍可能触发自动压缩，压缩后合成Continue令其再次读取和续写；受控read还可能注入上级AGENTS。详见Run下`evidence/worker8-output-diagnosis.md`。本次未修改这些宿主行为，三Worker配置不能宣称已经解决它们。

## 每轮是否新Agent

opencode.ts为每次调用启动`run --pure --format json --dir ... --title ...`，未带session/continue恢复参数。实际Worker事件记录：

| round | sessionID |
| --- | --- |
| 1 | ses_ea3118b7cffeoTLRD0JBa3oMpO |
| 2 | ses_ea223a010ffejaFtRB8acPhl7k |
| 3 | ses_ea20fb568ffegkpxCZ506pdik3 |
| 4 | ses_ea20729b1ffeKx7PxCdORUFHu4 |
| 5 | ses_ea1eace98ffeiCBeYt2nwI2T6F |
| 6 | ses_ea1af27adffeZih7YQY4cIbD7M |
| 7 | ses_ea17b2b3bffe2sne10Pzvwo0Gm |
| 8 | ses_ea08e6e61ffekc47gTvhXEYk1F |

跨轮保留文件形式的候选、反馈和运行记忆，不是旧聊天历史。一次调用内自动压缩并续写，与AEV切换round不是同一件事。

## 修正与三Worker职责

通用适配提示明确：全局目标只是背景，Worker只分析声明范围；Lead才是最终作者；除非分析目的明确要求草稿，否则不输出整份替代产物。允许说明问题所需的小段示例。不提取分析JSON、不截断最终回答、不扩大权限。

| Worker | 输入与职责 | 权限 |
| --- | --- | --- |
| sources | 来源001–025、当前候选、索引；分析可迁移规则、证据和冲突 | 只读 |
| coverage | 来源026–050、当前候选、索引；分析缺失条件、例外和覆盖范围 | 只读 |
| feedback | 当前候选、索引、训练答案格式、正式反馈；核对候选指纹、长度单位、规则冲突和泄漏风险 | 只读 |

前两组互斥且并集严格50份。第三名不授予全部来源文件，不能把索引当作已读原文。Lead仍有原全局资源权限，完整接收三份最终分析并综合修订。

所有角色仍MiniMax M2.7，原私有接口和账号不变，凭证不入文档。原长度门为4999 NFC非空白Unicode码点上限，不是字节、token或含空白字符数。无Opt、val24、test172；未启用分支探索。

## 并行与测试

复用runCampaignWorkers的`join(workerRoles.map(async ...))`。join使用Promise.allSettled，同时启动并等待所有Worker结束，才调用Lead；不新增调度器。真实请求仍受共享网关并发门控制，配置并行不等于已经实测接口重叠。

新增离线测试在真实Campaign路径设置三方启动屏障：串行执行会超时失败；Lead须看到三者均完成。覆盖两个round和多次验收，另测候选迁移后资源隔离、完整回答传递。两文件完整回归46通过、0失败、6068断言。没有真实模型调用，不代表三Worker已证明涨分。

证据：Run下`evidence/three-workers-full-regression.log`、`evidence/three-workers-regression-2.log`、`evidence/three-workers-migration-dry-run.json`。

最终typecheck仍97条诊断，与`round20-typecheck-final.log`逐条比较差异0，不宣称全仓通过。日志`evidence/three-workers-typecheck.log`。Git diff检查通过。首次从仓库根运行测试被根目录禁测规则拒绝，未发模型请求；正确入口是auto-evolve目录。

## 显式迁移与剩余问题

脚本：Run下`configure-three-workers.ts`。原配置、Campaign、wallet、intake、execution完整备份在`recovery/three-workers-007`。仅Worker声明变化；重新生成准备产物、绑定原Campaign；旧反馈通过保留原哈希证据的Host迁移派生新视图，不覆盖旧结果。二次prepare确认reused，candidate/wallet哈希不变。完成记录为该目录`completed.json`，状态configured_not_resumed。

账本仍有1笔MiniMax executor reserved请求，尚无完整结算证据，不能当作0消耗；4笔历史unknown已核查但仍为unknown。旧检查脚本只找pending会漏reserved。自动压缩续写、隐式AGENTS注入亦待修复。未解决前，不因增加Worker盲目恢复或重复发请求。
