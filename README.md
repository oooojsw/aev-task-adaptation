# OpenCode Auto-Evolve LongTask

这是一个基于 OpenCode 改造出来的 Auto-Evolve 长程任务实验系统。它不是原版 OpenCode 的简单镜像，而是在 OpenCode 底座上加入了长程任务、自进化经验区、空白 Agent 闭卷验收、多数据集运行、断点续传、运行看板和验证器体系的一套实验工程。

本仓库的目标是验证一件事：

> 能否让多个训练阶段的 Agent 从真实任务中提炼出可复用的专家经验，然后让一个完全没有历史记忆的空白 Agent 只依靠这份经验，在闭卷条件下完成同类任务。

## 目录结构

```text
auto-evolve/        Auto-Evolve 长程任务系统核心代码
packages/           OpenCode 底座源码及本项目需要的底层改造
script/             项目级辅助脚本，例如源码导出脚本
进度记录/           项目设计、迁移、验证链路、运行策略等长期记录
进度报告/           任务运行、事故复盘、阶段性实验输出等报告
README.opencode.md  原版 OpenCode README，作为底座参考保留
```

其中 `auto-evolve/` 是本项目最重要的目录。后续 Agent 如果接手这个项目，应优先阅读：

```text
auto-evolve/README.md
```

根目录的 `进度记录/` 和 `进度报告/` 已经从 `auto-evolve/` 下的历史记录合并到上层，方便在仓库首页附近统一查看。README 不再逐条列出这些记录文件，避免把项目首页写成杂乱索引。

## 核心思想

Auto-Evolve 的核心不是“让模型直接把某一道题做出来”，而是构建一个闭环：

```text
真实任务执行 -> 失败/成功轨迹 -> 经验区修订 -> 表面验证 -> 空白 Agent 闭卷验收 -> 产物验证
```

关键原则：

- 训练阶段可以开卷，用来发现任务规律、失败原因和可迁移方法。
- 最终证明必须依赖空白 Agent 闭卷验收。
- 空白 Agent 只能看到原始材料和专家经验区，不能看到答案、历史轨迹、验证器私有输入或系统内部记忆。
- 专家经验区不能硬编码具体答案，必须写成可复用的操作方法。
- 验证器分为表面验证和产物验证，分别防止经验作弊和检查最终答案是否正确。

## 主要模块

### 长程任务执行

位置：

```text
auto-evolve/orchestrator/long-task/
auto-evolve/orchestrator/long-task-campaign/
```

负责把复杂任务拆成多轮执行、失败分析、经验修订和断点续传。每个 campaign 会保存状态文件、轮次记录、工作记忆、路由控制和待验收专家经验包。

### 空白 Agent 验收

位置：

```text
auto-evolve/orchestrator/blank-eval/
```

负责创建无历史上下文的闭卷执行环境。它是系统判断专家经验是否真的有用的核心门槛。

### 验证器体系

相关位置：

```text
auto-evolve/orchestrator/validation-engine/
auto-evolve/orchestrator/long-task/validators.ts
auto-evolve/scripts/validate-*.py
```

验证器大致分为：

- Surface Validator：检查专家经验区是否泄露答案、是否满足布局和格式要求。
- Product Validator：检查空白 Agent 或任务执行产物是否正确。
- Soft Validator / Judge：用大模型按规则做主观评价或诊断。
- Regression / Replay Validator：检查合并后的经验是否退化。

### 运行看板和恢复

相关位置：

```text
auto-evolve/scripts/update-run-dashboard.ts
auto-evolve/scripts/run-benchmark-orchestrator.ts
auto-evolve/orchestrator/run-health.ts
```

用于集中查看当前任务、判断假活、卡死、恢复中、已完成等状态。真实运行状态不要只看前端卡片，应结合统一看板、`campaign.json`、心跳和 owner PID 判断。

### 数据集和任务包

常见位置：

```text
auto-evolve/dataset/
auto-evolve/task-packs/
```

项目已经接入或规划接入的任务类型包括 OfficeQA、SpreadsheetBench、SearchQA、DocVQA、ALFWorld 等。其中 OfficeQA / SpreadsheetBench / DocVQA / ALFWorld 更适合验证长程任务能力。

## 常用命令

进入项目根目录：

```powershell
cd "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
```

安装依赖：

```powershell
bun install
```

查看 Auto-Evolve CLI：

```powershell
bun run auto-evolve/cli.ts --help
```

刷新运行看板：

```powershell
bun run auto-evolve/scripts/update-run-dashboard.ts
Get-Content auto-evolve/runtime-state/run-dashboard/active-runs.md
```

导出项目源码到桌面：

```powershell
node script/export-project-source-to-desktop.mjs
```

导出前端源码到桌面：

```powershell
node script/export-frontend-source-to-desktop.mjs
```

停止并核查 Auto-Evolve session：

```powershell
powershell -ExecutionPolicy Bypass -File script/stop-auto-evolve-sessions.ps1
```

## 运行原则

1. 不要手工替任务补答案。
2. 不要人工替空白 Agent 修最终产物。
3. 优先修平台层：状态机、恢复逻辑、验证器、prompt、权限隔离、运行看板。
4. 原始材料和私有答案必须隔离，不能暴露给空白 Agent。
5. 长任务异常恢复依赖磁盘状态断点续传，不依赖恢复旧 OpenCode 对话 session。
6. 运行时产物、缓存、私有数据和大文件不应进入 Git。

## Git 与仓库说明

这个仓库是清理后的公开/私有远端代码仓库版本，已经尽量排除了运行产物、缓存、私有答案、数据集大文件和历史垃圾文件。

如果需要完整实验数据、运行产物或本机历史，需要在本机指定目录查看，不应直接同步到 GitHub。

## 给后续 Agent 的接手顺序

1. 先读根目录 `README.md`，确认这是 OpenCode + Auto-Evolve 的合并工程。
2. 再读 `auto-evolve/README.md`，了解 Auto-Evolve 的完整架构和红线。
3. 查看 `进度记录/`，理解最近的设计决策。
4. 查看 `进度报告/`，理解最近的运行结果和事故复盘。
5. 刷新运行看板，不要只相信前端 UI。
6. 修改核心流程后，同步更新 README 或进度记录，避免知识只留在聊天里。

## 原版 OpenCode

原版 OpenCode README 已保存在：

```text
README.opencode.md
```

如果需要对照底座能力、安装说明或上游项目介绍，请查看该文件。
