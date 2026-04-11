<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->

# 经验工作区入口

状态：已初始化

## 任务总目标

解析中文条件句"如果有X，必然有Y"，提取指定字符并按要求输出。

## 读取顺序

1. 先读本 manifest.md
2. 再读 `rules.md` 了解规则模式
3. 执行前检查 `output_contract.md` 确认输出格式
4. 参考 `execution_checklist.md` 执行

## 文件导航

| 文件                   | 角色                | 说明           |
| ---------------------- | ------------------- | -------------- |
| manifest.md            | entry               | 本入口文件     |
| change_log.md          | change_log          | 变更记录       |
| rules.md               | rule_module         | 规则模式与示例 |
| output_contract.md     | output_contract     | 输出契约       |
| execution_checklist.md | execution_checklist | 执行清单       |

## 工具说明

本工作区暂不包含辅助脚本或技能文件。如需工具辅助，可在 `tools/` 或 `skills/` 下添加。

## 适用范围

- 任务类型：文本精确提取
- 输入语言：中文
- 比较模式：text_exact（精确匹配）
