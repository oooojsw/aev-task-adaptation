# merge-as-opt 可拔插接入计划

## 目标

在不改变 `merge-as-old` 和 `merge-as-long-task` 默认行为的前提下，增加第三个合并后端 `merge-as-opt`。它只消费 AEV 已产出的单 case skill，不传递 AEV 对话轨迹、工具调用或 failure packet；合并完成后仍回到 AEV 原有的表面验证、空白 agent 回撤、测试集和实验总账。

## 总控

- `mergeConfig.mode = skillopt` 选择第三后端，CLI 同时接受 `--merge-execution-mode skillopt` / `merge-as-opt` / `opt`。
- `mergeConfig.asSkillOpt` 管理 SkillOpt 项目路径、Python 命令、SkillOpt YAML 模型配置、分层 batch size、合并并发和初始 skill。
- 默认仍保持 `legacy_script`，新后端未显式选择时绝不启动。

## 数据流

1. benchmark 训练阶段生成单 case skill。
2. `merge-as-opt` 默认只选择 `verified_success` 的 skill。
3. AEV 把每个多文件 skill 编码为带严格相对路径边界的完整 skill candidate。
4. SkillOpt `full_rewrite_minibatch` 按 batch 分层合并所有 candidate，直到只剩一个完整 skill。
5. AEV 解码合并结果；重复路径、绝对路径、`..` 逃逸、隐藏文件或边界缺失全部 fail closed。
6. 产出标准 `mergedSkillDir`，运行现有 `post_merge` 验证模块。
7. 通过后继续运行现有 merge acceptance profile，包括回撤、repair、final replay 和 held-out test。

## 鲁棒性

- SkillOpt root、config 和 Python 在启动模型前全部预检；配错时不发 API 请求。
- 使用文件 JSON 传递大 skill，不把内容拼进 Windows 命令行。
- 输出目录必须为本 run 下的专用目录，解码时再次校验所有目标路径位于该目录内。
- Python 返回非 0、超时、结果 JSON 缺失或没有唯一 `new_skill` 时不得当成合并成功。
- 保存 input manifest、SkillOpt request/result、stdout/stderr、模型配置路径和来源 skill 列表，记录 `merge-as-opt` lineage。

## 烟测

- 配置 normalize：新模式和新配置均能从总控加载，旧默认不变。
- Skill package 往返：Markdown、JSON、脚本子目录的文件名和内容不丢失。
- 负向路径：绝对路径、`../`、重复路径、隐藏文件、symlink 和边界外文本全部被拒绝。
- Mock SkillOpt 进程：不发 API 请求的情况下验证输入 manifest、输出物化、report 和 lineage 所需字段。
- 静态检查 benchmark 与 schema，确保原有两条分支仍可解析。

## 完成标准

- 总控一处切换三种合并后端。
- `merge-as-opt` 能返回标准 `mergedSkillDir`。
- 合并后的表面验证、回撤和测试不需要为 SkillOpt 重写。
- 原有 `merge-as-old` / `merge-as-long-task` 烟测仍通过。

## 2026-07-22 实施复核

- [x] 总控已支持 `legacy_script / long_task / skillopt` 三种正式后端；默认仍为 `legacy_script`。
- [x] `mergeConfig.asSkillOpt` 已集中管理 SkillOpt 根目录、通用 YAML、Python、batch、workers、timeout、初始 skill 和优化器覆盖项。
- [x] 只把 AEV 的 `verified_success` skill 作为完整候选送入 SkillOpt，没有接入轨迹、工具调用或 failure packet。
- [x] 多文件 skill 使用严格文件边界协议往返，Markdown、嵌套 casebook 和脚本文件均可保留。
- [x] 绝对路径、`..`、隐藏路径、重复路径、二进制文件、symlink、边界外文本均 fail closed。
- [x] SkillOpt 输出已重新物化为标准 `mergedSkillDir`，并复用 AEV 的 post-merge validation、replay、repair、final replay 和 test 链路。
- [x] 断点续传会保留 merge-as-opt 后端及其模型/并发/路径配置，不会静默切回 merge-as-old。
- [x] 实验账本会明确记录 `merge-as-opt`，且输入数量按实际参与合并的 skill 计算。
- [x] 新 smoke、旧 merge acceptance、merge-as-long-task 单层/分层/live supervisor、续传和实验账本 smoke 均通过。
- [x] 真实 SkillOpt Python 包和通用配置完成无 API 的导入预检。
- [ ] 未发起真实付费模型合并；这属于正式实验，不属于无费用 smoke，需在用户选择具体数据和模型后运行。

整仓 `tsc` 仍会被既有 runtime-state 生成脚本和仓库历史类型错误阻断；本次改动使用逐文件 Bun 语法检查、Python 编译、真实 SkillOpt 导入预检和上述运行时 smoke 完成可归因验证。
