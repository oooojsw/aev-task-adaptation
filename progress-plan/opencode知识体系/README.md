# OpenCode 知识体系

这是一套面向学习和长期维护的 OpenCode 知识文档。

目标不是解释某一个零散命令，而是把下面这些事情讲清楚：

- OpenCode 到底是什么
- Session 是怎么产生、运行、结束和复用的
- 我们到底能控制 OpenCode 的哪些东西
- 我们能看到它的哪些运行信息，哪些又看不到
- `auto-evolve` 是怎么调用 OpenCode 的
- 当前项目里和 OpenCode 相关的模型、权限、监控、限流是怎么工作的

## 推荐阅读顺序

1. [01-OpenCode总体认识.md](01-OpenCode总体认识.md)
2. [02-Session生命周期与操作.md](02-Session生命周期与操作.md)
3. [03-run命令与可控制项.md](03-run命令与可控制项.md)
4. [04-工具调用-事件流-可观测性.md](04-工具调用-事件流-可观测性.md)
5. [05-auto-evolve如何对接OpenCode.md](05-auto-evolve如何对接OpenCode.md)
6. [06-权限-模型-限流-配置.md](06-权限-模型-限流-配置.md)
7. [07-监控-调试-排错.md](07-监控-调试-排错.md)
8. [08-我们现在能控制什么不能控制什么.md](08-我们现在能控制什么不能控制什么.md)
9. [09-源码入口与学习路线.md](09-源码入口与学习路线.md)

## 这套知识体系重点回答的问题

### 1. Session 可以做什么

- 新开
- 续跑
- fork
- 列表查看
- 删除
- 监控
- 浏览器 dashboard 查看

### 2. OpenCode 运行时到底会发生什么

- 接收 prompt
- 选择模型和 agent
- 调用工具
- 产生事件流
- 写入 session 消息与状态
- 最终输出文本、错误、工具结果和 step 信息

### 3. 我们项目里和 OpenCode 的关系是什么

- `auto-evolve` 不直接自己实现 agent
- 它是把任务包装后交给 OpenCode 跑
- 再把 OpenCode 的结果、事件和 session 记录整理成实验产物

### 4. 当前最重要的现实结论

- 我们现在已经能比较稳定地控制：
  - 模型
  - agent
  - variant
  - 运行目录
  - session 标题
  - Session 监控
  - 纯路径输入方式
  - 本地限流
  - 项目级权限模式
- 我们现在也已经能比较稳定地看到：
  - 工具调用
  - 工具输入输出摘要
  - step 开始和结束
  - assistant 最终文本
  - 错误
  - session 状态
- 但我们仍然不能完整看到：
  - 模型私有思考链
  - provider 内部隐藏推理
  - 未暴露到 session/event 的内部状态

## 适合和这套文档一起看的源码入口

- `packages/opencode/src/cli/cmd/run.ts`
- `packages/opencode/src/cli/cmd/session.ts`
- `packages/opencode/src/session/processor.ts`
- `auto-evolve/orchestrator/opencode.ts`
- `auto-evolve/orchestrator/session-execution-report.ts`
- `auto-evolve/orchestrator/monitor.ts`
