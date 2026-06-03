# OpenCode 执行层隔离与运行时清理改造记录

## 背景

这次改动的目标很明确：

1. 让每一次 OpenCode 子进程执行都尽量像“一次性任务”，不要长期占住共享运行时。
2. 尽量减少运行过程中对磁盘空间的持续占用，尤其是 OpenCode 自己生成的 session、db、cache、临时目录。
3. 不破坏现有的断点续传、并行执行和外层状态机能力。

问题的根子不在外层 `runtime-state`，而在 OpenCode 子进程内部仍会落共享运行时数据。这样虽然外层是 one-shot 调用，但里面还是会留下持续增长的 session 和状态文件，久了就会带来：

- 磁盘膨胀
- 锁冲突
- 残留 runtime 目录难清理
- 运行中途断联或假死看起来更频繁

## 这次改了什么

### 1. 给 OpenCode 执行加了默认隔离 runtime

核心文件：

- `auto-evolve/orchestrator/opencode.ts`

现在每次 `runOpencodeTask(...)` 默认都会判断是否启用独立 OpenCode runtime。启用后会为这次执行单独准备：

- `HOME`
- `XDG_DATA_HOME`
- `XDG_STATE_HOME`
- `XDG_CACHE_HOME`

也就是说，这次 OpenCode 的内部落盘不会再尽量复用同一套共享目录，而是走本次 attempt 自己的隔离目录。

### 2. 子进程结束后自动清理这次的临时运行目录

还是在：

- `auto-evolve/orchestrator/opencode.ts`

这次增加了结束清理逻辑。只要这次子进程跑完，不管成功还是失败，都会尽量清掉：

- 本次 override config 目录
- 本次 isolated env 目录

这样可以避免“任务结束了，但运行时垃圾还留着”的情况。

### 3. 加了过期目录的自动清理

同样在：

- `auto-evolve/orchestrator/opencode.ts`

新增了一个 stale 清理器。它会在启动时顺手扫一遍旧的 OpenCode 临时目录，把超过保留时间的残留目录清掉。

这个清理只针对本次项目自己生成的 OpenCode 临时目录，不会碰外层的长期状态仓库。

### 4. 把“是否能 open”从“是否隔离 runtime”里拆开了

还是在：

- `auto-evolve/orchestrator/opencode.ts`

之前这里有一层耦合：一旦启用隔离 runtime，就可能把权限判断变窄。

这次把它拆开了。现在是否开放 shell 权限，不再因为“启用了隔离 runtime”而自动收紧，而是只看真实的权限配置。

这样做的目的很简单：

- 隔离的是 OpenCode 自己的运行时
- 不应该误伤任务本身的权限能力

### 5. 让一些原来显式关闭隔离的调用点，改成继承默认策略

改动文件：

- `auto-evolve/orchestrator/blank-eval/runner.ts`
- `auto-evolve/orchestrator/skillsbench-adapter.ts`

这两个地方之前是显式写死不走隔离。现在去掉了这个硬编码，让它们统一跟随新的默认行为。

这样以后不需要每个入口都手工维护一套“要不要隔离”的特殊分支。

## 这次改动的逻辑

可以把这次改动理解成三层：

### 外层

外层还是原来的 auto-evolve 状态机，负责：

- long-task / campaign 的启动
- 断点续传
- 并行调度
- 结果落盘

这层没有被破坏。

### 中间层

中间层是 `runOpencodeTask(...)`，负责给每次 agent 执行起一个独立子进程。

这层本来就已经是 one-shot，现在只是把它做得更像“每次跑完就收干净”。

### 内层

内层是 OpenCode 自己的 session/db/cache/state。

这次的重点，就是尽量让它不要再把垃圾长期堆在共享位置。

## 为什么不会破坏现有能力

### 1. 断点续传还在

因为真正的续传逻辑在外层 `runtime-state`，不是靠 OpenCode 原生 session 继续聊天。

也就是说：

- 外层状态机还在
- 任务轮次还在
- 回到断点继续跑的能力还在

### 2. 并行能力还在

并行的关键是：

- 每个任务仍然是独立子进程
- 只是每个子进程的内部运行时更独立了

这不会把并行变成串行。

### 3. 只影响 OpenCode 自己的运行垃圾

这次清理的对象主要是：

- 本次 attempt 的 OpenCode 临时目录
- 本次 attempt 的隔离环境目录
- 过期的 OpenCode 临时目录

不会主动去动：

- 长期的 `runtime-state`
- campaign 的主状态文件
- 外层任务历史

## 验证情况

已做的检查：

- `bun --check auto-evolve/orchestrator/opencode.ts`
- `git diff --check`

结果都通过。

另外我也跑过一次整体验证命令，但它失败的原因主要是仓库里已有的历史 runtime / 旧任务数据不完整，不是这次执行层改动本身引入的新错误。

## 0604 十 session 空间烟测

为了确认这次改动不是“理论上会清理”，而是真的不会重新制造过去那种每个 session 一份 `node_modules` 的暴涨问题，新增并执行了专门烟测脚本：

- `auto-evolve/scripts/smoke-opencode-runtime-cleanup.ts`

这次烟测做了这些事：

1. 创建一个干净的临时 runtime root。
2. 并发启动 10 个真实 `runOpencodeTask(...)` / `opencode run` session。
3. 记录运行前后的目录体积、文件数、目录数、`node_modules` 数量。
4. 检查 `opencode-config` 和 `opencode-isolated-env` 在 session 结束后是否被清空。

第二轮有效结果：

- 10 个 session 全部 `exitCode=0`
- 10 个 session 工具失败数为 0
- `opencode-config` 结束后：0 bytes / 0 files / 0 directories
- `opencode-isolated-env` 结束后：0 bytes / 0 files / 0 directories
- `node_modules` 残留数量：0
- 整个临时 runtime root 最终增量：2471 bytes
- 剩余内容主要是 `opencode-gate` 的 2 个很小状态文件
- 运行结束后未发现残留 `opencode.exe` 进程

这说明本次改造对最关键的历史问题是有效的：不会再因为 10 个 session 留下 10 份 `node_modules`，也没有把每次 OpenCode 内部 sqlite/session/cache 长期留在本次 runtime 里。

注意：本机当前没有挂载 `D:`，所以默认 runtime 策略会回退到项目所在盘。烟测使用的是干净临时 runtime root，目的是把历史目录噪声排除掉，验证执行层本身的清理行为。

## 对后续的影响

这次改完以后，后续如果继续往“更轻量的执行层”走，方向会更清楚：

1. 外层继续保留断点续传和并行。
2. OpenCode 子进程继续保持 one-shot。
3. OpenCode 内部 runtime 尽量隔离并及时清理。
4. 后面如果还要继续瘦身，再考虑把 `runtime-state` 本身也做成可配置路径，进一步把长期产物从 C 盘挪走。

## 一句话结论

这次不是把系统改成一个全新的模式，而是把现有架构里最容易膨胀、最容易留下锁和垃圾的那一层收紧了。

结果是：

- 外层断点续传没丢
- 并行没丢
- OpenCode 的内部运行垃圾更可控了
- 临时目录和旧残留更容易被自动清理
