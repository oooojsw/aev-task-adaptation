# 2026-07-06 分层 merge-as-long-task supervisor 补强计划

## 背景

现在系统里有两条合并路线：

- 旧路线：`legacy_script`，也就是原来的脚本式合并、回撤、repair。它必须完整保留，仍然是默认路线。
- 新路线：`long_task`，也就是把“合并多个 skill”本身包装成长程任务，让合并 agent 也经过表面检查和空白验收。分层版本会先把一批 skill 分成多个小组，每组产出一个中间 skill，再把中间 skill 继续合并，直到只剩最终 skill。

上一版已经做到：可以生成分层任务包，可以按层跑 group campaign，也能识别已有健康 campaign 并观察、对 recovery/stale 任务执行 resume。但它还不是完整 supervisor，状态可追踪性和续传鲁棒性还需要补强。

## 本次目标

本次不重写全系统，只补齐最关键的工程闭环：

1. **最终 skill 路径必须指向真实晋级 skill**  
   最终层成功后，优先使用 campaign 的 `pending-expert-package/current`，而不是默认猜 `task/workspace/merged-skill`。否则最终报告可能指向一个不存在或不是正式转正的目录。

2. **每一层、每一组都要写入可读状态账本**  
   `hierarchical-live-state.json` 不能只写一坨原始 group result。它应该能直接看出每组是 `verified_success`、`watch_live`、`recovery`、`failed`、`dry_run`，并记录 campaignID、campaignDir、health、outputSkillPath、summary。

3. **观察参数进入总控配置**  
   分层 supervisor 的观察间隔和最大观察轮数不能写死在脚本里。新增：
   - `watchPollMs`：观察健康运行 campaign 的轮询间隔。
   - `watchMaxPolls`：最多观察多少次，超过后 fail closed。

4. **CLI 支持覆盖观察参数**  
   `run-hierarchical-merge-long-task.ts` 增加 `--watch-poll-ms` 和 `--watch-max-polls`，方便烟测用短轮询，真实任务用长轮询。

5. **smoke 覆盖关键风险**  
   扩展 `smoke-hierarchical-merge-live-supervisor.ts`：
   - 确认 recovery_pending 会被 resume。
   - 确认最终 skill 路径来自真实 campaign 的 pending package。
   - 确认 live state 里有每组状态和 outputSkillPath。

## 不做的事情

本次不做这些大改，避免影响原链路：

- 不删除或替换旧的 `legacy_script` 合并流程。
- 不改变默认 `mergeConfig.mode`。
- 不做持久 task lease 数据库。
- 不做 Direct Chat 或 held-out test 的新桥接。
- 不修改普通单点长程训练逻辑。

## 验收标准

完成后至少跑：

```powershell
bun --check auto-evolve/scripts/run-hierarchical-merge-long-task.ts auto-evolve/orchestrator/schema.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-live-supervisor.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
```

并回读本计划，确认上面的 5 个目标都已落地。
