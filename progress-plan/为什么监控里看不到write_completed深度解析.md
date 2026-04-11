# 为什么监控里看不到 write:completed——深度解析

> 编写日期：2026年4月11日
> 面向读者：需要深入理解监控机制为什么无法显示文件写入动作的人
> 注意：本文档不涉及代码细节，仅解释数据流程和原理

---

## 一、先说结论（TL;DR）

监控里看不到 `write:completed`（写入完成）不是因为代码坏了，而是因为三个"数据过滤器"把信息过滤掉了：

| 过滤器 | 发生位置 | 效果 |
|--------|---------|------|
| **内容压缩（Compaction）** | OpenCode Session 内部 | 写入的内容被"[旧内容已清除]"替代，导致 detail 变成无效文本 |
| **detail 字段取值逻辑** | Monitor 前端代码 | detail 优先显示"写入成功"这句话，而不是文件名 |
| **Recent Actions 容量限制** | Monitor 前端代码 | 只显示最近6条动作，写入动作被更新的步骤事件挤出去了 |

`read:completed`（读取完成）同样受影响，只是它还残留一些痕迹（`step_finish:tool-calls`），而 `write:completed` 因为内容被完全清除所以彻底消失了。

---

## 二、OpenCode 工具执行结果的数据结构

理解这个问题需要先知道工具执行后返回了什么。

以"写入文件"工具为例，工具执行完成后返回给 Session 的信息包含三个关键字段：

| 字段名 | 含义 | 示例值 |
|--------|------|--------|
| `tool` | 工具类型 | `"write"` |
| `title` | 操作的文件路径 | `"knowledge-pack/change_log.md"` |
| `output` | 操作的结果文字 | `"Wrote file successfully."` |

注意：`title`（文件名）和 `output`（"写入成功"这句话）是**两个完全不同的字段**，它们存放的位置和含义都不一样。

以"读取文件"工具为例，返回的是：

| 字段名 | 含义 | 示例值 |
|--------|------|--------|
| `tool` | 工具类型 | `"read"` |
| `title` | 被读取的文件路径 | `"case-001/material/input.txt"` |
| `output` | 文件的实际内容 | `"文件的第一行内容..."`（很长）|

---

## 三、过滤器一：Compaction（内容压缩）——最核心的原因

### 3.1 什么是 Compaction

Session 在运行过程中会不断积累 token 数量。当累积的 token 达到一定规模（超过 40,000 个 token 的工具输出量）时，OpenCode 会执行一次 **Compaction（压缩）** 操作。

Compaction 的目的是释放上下文空间——把旧的、已经用过的工具输出从 Session 的"记忆"中清除，但保留工具被调用过这个事实。

### 3.2 Compaction 具体做了什么

Compaction 从 Session 的最老的消息开始，往回扫描工具调用记录。当发现旧的工具输出累积量超过阈值时，对这些工具执行"清除"操作：

```
清除前：
  output = "文件的第一行内容\n第二行内容\n第三行内容..."  （真实文件内容）

清除后：
  output = "[Old tool result content cleared]"                       （被替换为占位符）
  title = "case-001/material/input.txt"                              （title 字段保留）
  metadata = { preview: [...], truncated: false }                    （metadata 也被清空）
```

注意：Compaction **只清除 `output` 字段的内容**，不改变 `tool` 字段（工具类型）和 `title` 字段（文件路径）。

### 3.3 对写入工具的影响

对于 `write` 工具：
- `output = "Wrote file successfully."` → 被替换为 `"[Old tool result content cleared]"`
- `title = "knowledge-pack/change_log.md"` → 保留
- `tool = "write"` → 保留

### 3.4 这和监控看不到写入有什么关系

Monitor（监控服务）每隔 2 秒读取一次 Session 的消息记录。读取到的是**当前时刻 Session 中实际存储的数据**——也就是说，如果 Compaction 已经执行过，Monitor 读到的是已经被替换为占位符的版本。

Monitor 在显示 Recent Actions（最近动作）时，会对每个工具执行一个"提取关键信息"的逻辑（函数名叫 `actionFromPart`）。这个逻辑对 `write:completed` 的处理是：

```
detail = output（被压缩后的值） ?? title
       = "[Old tool result content cleared]" ?? "knowledge-pack/change_log.md"
       = "[Old tool result content cleared]"

因为 output 不为空（是占位符字符串），所以不会 fallback 到 title（文件名）。
```

结果：Recent Actions 显示 `write:completed [Old tool result content cleared]`。

这个占位符文本虽然技术上代表"有工具调用"，但对人类来说完全无法理解——所以用户感觉就是"没有写入记录"。

### 3.5 对读取工具的影响

对于 `read` 工具同样的事情发生了：
- `output = "文件的第一行内容..."` → 被替换为 `"[Old tool result content cleared]"`
- Monitor 的处理：`detail = "[Old tool result content cleared]"`

所以 `read:completed` 同样被这个机制影响，读取的内容也无法显示了。

---

## 四、过滤器二：detail 字段的取值逻辑——文件名去哪了

即使 Compaction 没有发生（Session 还很新），Monitor 显示 `write:completed` 时也面临另一个问题。

Monitor 在显示工具的 `detail` 时，有一段取值逻辑：

```typescript
// 伪代码，不代表真实语法
if (工具状态 === "completed") {
  detail = output  // output = "Wrote file successfully."
} else if (工具状态 === "error") {
  detail = error信息
}
detail = detail ?? title  // 只有当 detail 为空时才用 title
```

也就是说，对于已完成 `write` 工具：
- `output = "Wrote file successfully."`（非空）
- `detail = output = "Wrote file successfully."`
- `title`（文件名）被完全忽略

所以即便 Session 还没有被压缩，Recent Actions 里 `write:completed` 显示的也是"写入成功"这句话，而不是具体在写哪个文件。

**对于 `read` 工具，情况稍微好一点**：`read` 的 `output` 是文件的实际内容（很长），显示出来虽然不是文件名，但至少还有点内容。

---

## 五、过滤器三：Recent Actions 只显示最近6条

Recent Actions（最近动作）这个区域只显示**6条**最近的 action，按时间顺序排列。

Monitor 从 Session 的消息中提取所有的 action，然后取最新的6条。

在一个 Auto Evolve 的 Session 中，典型的时间线是：

```
[reasoning] → [reasoning] → [read:completed] → [read:completed]
→ [step_finish] → [reasoning] → [reasoning] → [write:completed] → [step_finish]
→ [reasoning] → [reasoning] → [read:completed] → [step_finish]
```

Recent Actions 只取最新的6条。在一个正在运行的 Session 中：
- 最新的位置被 `step_finish:tool-calls`（步骤完成，消耗 token）和 `step_start`（步骤开始）占据
- 再加上 `reasoning`（模型思考）
- 再加上偶尔的 `read:completed`（读取文件）
- `write:completed`（写入文件）因为发生次数少，很容易被挤出去

而且，因为 Compaction 不断清除旧的工具输出，在一个长时间运行的 Session 中，越早发生的工具调用越难保留在 Recent Actions 的 6 条槽位里。

---

## 六、综合效果：为什么完全看不到

把三个过滤器叠加在一起：

**场景：一个运行了一段时间（比如10分钟）的 Auto Evolve Session**

1. **Compaction 已执行**：旧的 read/write 工具输出全部被替换为 "[Old tool result content cleared]"
2. **Recent Actions 只剩最新6条**：其中大部分是 `step_finish`（步骤完成）和 `reasoning`（思考），写入动作可能已经被挤出去了
3. **即使看到了 `write:completed`**，detail 也是 "[Old tool result content cleared]"（因为 Compaction）或者"写入成功"（因为 detail 取值逻辑问题）

最终效果：**用户完全感受不到写入动作的存在。**

---

## 七、`step_finish:tool-calls` 到底是什么

在监控的 Recent Actions 中，你经常看到：

```
step_finish:tool-calls tokens:21762
```

这代表什么意思？

`step_finish` 是 OpenCode 的"步骤结束"事件，不是工具完成事件。它记录的是：**这个步骤（step）总共消耗了多少 token**。

`tool-calls` 只是说这个步骤里有工具调用，`tokens:21762` 表示这个步骤用了 21762 个 token。

所以你看到的 `step_finish:tool-calls` **不是** `read:completed` 或 `write:completed`，它只是告诉你"这个操作步骤花了多少算力"。它不等于具体的工具完成记录。

---

## 八、为什么 `read:completed` 多多少少还有点痕迹

`read` 工具的输出是文件内容（很长一段文字），即使被 Compaction 清除，在 Recent Actions 中也留下了这些痕迹：

- `step_finish:tool-calls tokens:21762`（步骤总消耗）

这是因为 `step_finish` 包含了这一步骤里所有工具调用的 token 总计。它不是 `read:completed`，但它从侧面告诉你"这个步骤里读了很多文件"。

而 `write` 工具的输出只有"写入成功"这一句话，太短了，不包含有意义的累计信息，所以即使从侧面也无法感知。

---

## 九、写入动作实际存在吗？——验证方法

如果你想确认"写入动作确实发生了，只是监控看不到"：

1. **查看知识包目录的修改时间**：每次知识维护后，`knowledge-pack/` 目录下的文件时间戳会更新
2. **查看 session 的输出报告**：每个 Session 结束后的报告文件里，记录了完整的工具调用清单，包括写入
3. **查看 runs 目录**：在 `auto-evolve/runs/` 下有每次运行的完整记录

监控界面看不到写入，不代表写入没有发生——只是监控这个渠道无法有效传达这个信息。

---

## 十、解决方案方向（仅供理解，不涉及代码修改）

如果要让 `write:completed` 在监控中可见，需要解决三个层面：

| 层级 | 问题 | 理想状态 |
|------|------|---------|
| **Compaction 层面** | 压缩后 `output` 被清空，文件名虽然保留但没放进 detail | 即使 output 被压缩，也应该用 `title`（文件名）填充 detail |
| **取值逻辑层面** | completed 工具的 detail 用 output 而不是 title | 对于 write 工具，优先显示 title（文件路径）而不是 output |
| **Recent Actions 层面** | 工具 action 容易被步骤事件挤出去 | 考虑把工具完成 action 单独一个区域显示，不受6条限制 |

这三个问题需要同时修复才能让 `write:completed` 清晰可见。单独修一个不够。
