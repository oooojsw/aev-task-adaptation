# Worker完整最终回答交付Lead

## 目标与边界

按用户要求，Worker像子智能体一样交付完整最终答复，Lead不再依赖从答复抽取的JSON建议字段。排除思考、工具调用/返回、工具前言和上下文压缩总结。适用共同Campaign、协议角色、多Skill合并Profile和task-adaptation；不是某轮或某条路线的临时补丁。

本次仅改代码、提示词和离线验证。未恢复50题真实任务、未新增外部模型请求，不改正式验收、钱包、选优或分支触发规则。

## 实现

1. OpenCode JSON事件增加assistant消息身份及summary标记，不输出模型思考。`worker-answer.ts`按最后正常stop结束的assistant消息收集text，按part去重，不读取responseText混合轨迹，也不解析回答中的JSON。
2. Worker最终正文原样写入角色目录`final-answer.txt`。`suggestion.json`保留角色、轮次、原始证据路径、正文哈希与状态等机器登记信息；它不再承载从自然语言提取的分析摘要。
3. 共同Lead入口校验正文哈希后授予精确文件读取权限，提示全文读取、必要时分页。同轮补验诊断Worker也纳入。它不把正文内的路径变成权限，也不把Worker意见当正式验收结论。
4. task-adaptation仍核对Plan、角色和轮次。授权视图为完整纯文本，不再选取summary/findings等字段；Reviewer和正式控制器的结构化合同保留。诊断的`pass-*`及`previous-pass-*`目录受同样校验。
5. 恢复读取保留正文身份与哈希，换轮/重试/候选目录迁移走共同入口。不能完整交付、length终止、压缩总结或身份缺失时明确标unavailable，不能用空JSON、旧摘要或部分轨迹冒充全文。
6. 历史事件缺最终消息身份时不会自动重发收费请求。旧冻结任务跨源码版本恢复仍需原有显式迁移/恢复程序；本改动不解除源码身份门禁。

全文通过只读文件交付，不强行全部塞进一次上下文。文件不裁剪不摘要，模型可分页读取；这不等于保证模型每次实际利用所有内容。模型上下文/工具读取预算仍有效。

## 验证与限制

- 最终7文件定向回归：46通过、1项真实接口测试跳过、0失败、378断言。包括完整最终正文、90KB以上正文、同文哈希、跨第1/7轮、第1/2次验收、候选目录变化、同轮/前轮补验诊断、篡改阻断，以及旧Campaign通过/拒绝/跨轮修订和无新调用恢复。
- 旧流程基线测试仅豁免本次有意改变的Worker提示词和Lead的Worker正文引用，独立核对新正文确实可读；其他请求、验收、调度和终态继续与旧Git基线对比。
- 实际源码OpenCode宿主连接本地合成HTTP接口的已完成Worker回执已核对：50个工具事件、6个assistant身份事件，交付最终正文249字节，不含题目工具返回。它仅证明该回执交付边界，不代表完整Consolidation整套验收通过。
- 两次较大Consolidation/报告E2E测试在运行中被停止，保留日志和现场，不计通过。完整报告/软件/多模式Consolidation及真实MiniMax联调尚未完成。
- 全仓类型检查退出1，97条诊断；本次修改文件未出现在诊断中，不宣称全仓通过或独立CI通过。

证据目录：`E:/project/AEV-50skill-consolidation-20261021/evidence/`。
最终回归：`worker-prose-final-tests.log`；宿主回执复核：`worker-prose-host-audit.json`；类型检查：`worker-prose-typecheck.log`；中止测试：`worker-prose-tests.log`、`worker-prose-campaign-tests.log`。

## 未在本次修复

Lead输出length但exit0继续送验、旧修复清单未迁入新上下文、已停止真实任务的unknown用量等问题仍独立存在。本改动不代表这几个问题已解决，也没有新的50题成绩。
