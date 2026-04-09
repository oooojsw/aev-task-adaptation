<!-- auto-evolve-bootstrap: generated -->

# 知识库总览

## 作用

- 这套知识库是 `auto-evolve` 的持久专家经验。
- 新的 solve agent 必须把这些 Markdown 文件当成长期记忆。
- 知识库默认使用中文编写，除非具体任务明确要求其他语言。

## 加载顺序

1. `core/expert_rules.md`
2. `core/output_contract.md`
3. `core/execution_checklist.md`
4. `patterns/general_rules.md`
5. `patterns/exceptions.md`
6. `lessons/failure_lessons.md`

## scripts 目录说明

- 可复用脚本位于 `../scripts`。
- `scripts` 提供能力，不是规则真源。
- 规则和经验应保存于知识库 Markdown 中。

## 当前状态

- 知识库已根据训练案例生成第一版专家经验。
- 核心任务：读取中文条件规则，输入"如果有X，必然有Y"，输出XY（两个字母的拼接）。
