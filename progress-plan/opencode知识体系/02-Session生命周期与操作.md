# Session 生命周期与操作

## 1. Session 是什么

Session 是 OpenCode 里最基本的运行单位。

你可以把它理解成：

**一次 agent 工作线程的完整上下文。**

一个 session 会保存：

- 这次工作叫什么
- 在哪个目录里工作
- 历史消息
- 工具调用
- step 信息
- 错误
- 状态
- 是否有父 session

## 2. Session 的常见生命周期

最常见的生命周期是：

1. 创建新 session
2. 进入运行
3. 调工具、输出文本、产生事件
4. 正常完成，或报错，或进入 retry
5. 后续可以继续、fork、监控、归档、删除

## 3. Session 有哪些常见操作

### 3.1 新建

最直接的方式就是跑一次 `run`。

这会创建一个新的 session，并开始执行。

### 3.2 continue

如果想接着上一次 session 继续跑，可以用：

- `--continue`
- 或 `--session <id>`

这表示不是全新开始，而是在已有 session 上继续。

### 3.3 fork

如果想在已有 session 基础上开一个新分支，而不是继续污染原 session，可以用：

- `--fork`

这非常重要，因为它意味着：

**session 也支持分支思维，不只是覆盖式续跑。**

### 3.4 列表查看

OpenCode 支持列出 session。

你可以看到：

- session id
- 标题
- 状态
- 更新时间
- 父子关系

### 3.5 删除

不再需要的 session 可以删除。

### 3.6 monitor

终端版 session 监控可以看：

- 当前有哪些 session
- 正在运行的是什么
- 最近状态

### 3.7 dashboard

浏览器版 dashboard 可以持续自动刷新。

它更适合长期盯着看。

## 4. Session 状态怎么理解

底层最核心的状态其实不多：

- `idle`
- `busy`
- `retry`

但为了让人更容易看，监控层会把它们扩展理解成：

- `running`
- `retry`
- `done`
- `error`
- `archived`
- `idle`

也就是说：

- `busy` 更像真正运行中
- `retry` 是正在等下一次尝试
- `done` 是已完成
- `error` 是以错误结束

## 5. Session 里“最近在干什么”是怎么判断出来的

当前监控系统主要通过这些线索推断：

- 当前有没有正在运行的 tool
- 有没有未结束的 text
- 有没有未结束的 reasoning
- 当前 step 是否打开但没 finish
- 最后一次 assistant 是否已经完成或报错

所以你在监控页里看到的：

- `tool:read`
- `tool:edit`
- `reasoning`
- `text`
- `done:stop`

本质上都是从 session 的最近消息 part 推断出来的。

## 6. 父子 Session 是什么

OpenCode 支持通过任务工具等方式产生子 session。

所以一个 session 可能有：

- `parentID`
- child sessions

这意味着它天然支持：

- 主 agent
- 子任务 agent
- 分支执行

这也是为什么后面做多 agent 编排时，Session 系统本身是有基础能力的。

## 7. 对我们项目最重要的 Session 结论

在 `auto-evolve` 里，很多关键阶段本质上都是一个 OpenCode session。

例如：

- bootstrap
- solve
- judge
- maintain
- verify
- regression

这些阶段虽然在实验层面叫不同名字，但运行时它们都对应：

**一个或多个 OpenCode session。**

所以以后你看实验系统，很多时候其实就是在看：

**它到底开了哪些 session，怎么组织它们。**

