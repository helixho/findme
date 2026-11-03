# T1 — Purposeful Exploration Loop

> 本文定义单次探索的具体功能契约；产品与领域语义不在这里重复定义。运行状态、测试结果和交接过程不属于本文。

## 1. Outcome Anchor

把单次探索从“AI 连续提问 + 每轮完整分析”改成：

`输入先保存 → 判断当前新增认识 → 只在高信息增益时追问 → 没有必要时停止 → 最终综合`。

本批必须同时改善两件事：

- 用户每轮知道“刚才的回答增加了什么、为什么还要问”；
- 普通回答不再等待完整 Understanding synthesis 后才确认保存。

本批不做跨 Experience 综合、历史 adapter、多角色、行动实验或正式多用户。

## 2. 固定产品规则

1. 追问没有默认轮数；默认问题预算为 3，hard cap 为 5。
2. 下一问必须对应一个明确 uncertainty，且不同回答会显著改变当前理解。
3. quick options 只是表达辅助，允许多选、混合答案和自由文本，不是分类器。
4. 连续两轮只增加细节、没有改变判断时必须停止。
5. 原始 Source/Evidence 不静默改写；更正、补充、时间更新都产生新来源与可追溯关系。
6. 用户输入事实先落盘；LLM 派生结果可以失败、重试、稍后恢复。
7. 最终 Claim/Gap 只在探索停止或用户主动“先到这里”时综合，不在每个回答后重做完整 synthesis。

## 3. Planner Contract

新增轻量 Exploration Planner。输入只包含当前 Experience 的有效 Evidence、已问问题、最近 step 与问题预算；输出：

```json
{
  "current_reading": "当前比上一轮更清楚的有限认识",
  "key_uncertainty": "真正会改变当前判断的未知；可为 null",
  "decision": "ask | stop",
  "question": "decision=ask 时唯一问题，否则 null",
  "intent": "为什么这题值得问；stop 时解释为什么停止",
  "quick_options": ["表达辅助"],
  "stop_reason": "decision=stop 时必填"
}
```

Ask gate：存在具体 uncertainty；不同答案会改变解释/范围；已有 Evidence 不能回答；信息增益值得再次打扰用户。否则必须 stop。

默认预算内可由 Planner 自动提出问题；达到预算后自动 stop。Review 页允许用户显式“再深入一次”，仍受 hard cap 约束，且 Planner 可判定无必要继续。

## 4. 写入与状态契约

`POST /explorations` 先原子写入 event Source/Evidence/Experience/Exploration，不等 LLM；返回 `ready_to_plan`。

`POST /explorations/:id/respond` 只做：version precondition、Question answered、answer Source/Evidence/Turn、operation completed；成功即表示用户回答已可靠保存。

`POST /explorations/:id/continue` 承担 Planner：没有 open question 才能执行。Ask 时持久化 ExplorationStep + Question；Stop 时持久化 Step，再执行一次 Final Synthesis 并发布 ClaimRevision/Gap。

恢复规则：active exploration 若无 open question、无可展示的 final understanding，则 phase=`ready_to_plan`；App 恢复后可以继续 Planner，不丢用户输入。

## 5. Amendment Contract

新增 SourceLink，表达 `supplements | corrects | updates`：

- supplements：原来源继续有效，新内容追加；
- corrects：旧来源保留但当前 assessment 改为 excluded，新来源成为有效证据；
- updates：旧来源继续作为过去事实有效，新来源表达当前变化，不把过去判错。

用户在 Evidence/回答处可以选择“补充一点 / 刚才说得不准确 / 现在已经不同”。更正或排除发生后，依赖旧证据的 current ClaimRevision 继续沿用既有 stale/invalid 传播规则；未回答的 open question 标记 superseded，重新进入 ready_to_plan。

## 6. Mobile UX（iPhone Chrome 优先）

- 输入字号不低于 16px，避免 iOS WebKit focus zoom；
- 底部主操作使用 safe-area inset，键盘出现时不依赖固定 bottom nav；
- Flow 页面使用 `100dvh` + `100vh` fallback，避免地址栏伸缩造成跳动；
- touch target 至少 44px；quick options 支持多选并在窄屏换行；
- 提交回答后先显示“已保存”，随后进入“正在判断是否还值得追问”，不能把保存和模型等待混成一个 spinner；
- Planner 失败时保留输入并允许重试/返回首页，恢复后继续同一 exploration。

## 7. 兼容与迁移

新增 migration 0008，仅增加 `exploration_steps` 与 `source_links`；不改写现有 production Source/Evidence/Claim 历史。

旧 exploration 若已有 claims，继续按既有 review/complete 流程读取。新链路只对本版本之后创建或继续的探索使用 Planner step；接口尽量保持旧字段兼容，但 App 以新 phase/response 为准。

## 8. Acceptance

1. Start 在模型不可用时仍保存 event，并可恢复为 ready_to_plan。
2. Respond 在模型不可用时仍保存 answer，且重复提交不重复写入。
3. A+C / A+B+C 形式的多选回答被保存为一条用户自述，不被强制归类。
4. Planner 只有在 Ask gate 成立时创建下一问；问题 3 后默认停止，问题总数不超过 5。
5. 每个 ask step 都持久化 current_reading / key_uncertainty / intent；App 明确展示追问目的。
6. stop 后只执行一次 Final Synthesis，形成可追溯 ClaimRevision/Gap。
7. 补充、更正、时间更新三类 amendment 语义不同；更正不会让旧错误 evidence 再进入后续分析。
8. iPhone Chrome 390–440 CSS px 宽度下无横向溢出，textarea 聚焦不触发页面缩放，底部操作不被 safe area 遮挡。

## 9. 策略校验、血缘与耗时契约

认识形成的分层原则由 TA 定义。具体策略和预算的执行源为 `apps/api/src/core/epistemic-policy.ts`，Prompt 读取策略。Planner 候选须通过确定性校验；重复问题、预算越界和已知明显范围越界不得创建下一问，连续两次候选不合格则安全 Stop。

Understanding/Revision 发布前检查引用、范围和已知人格化推断；拒绝原因进入下一次生成约束，两次失败不发布认识，保留可重试状态。否定、引文和明确未知不能当作肯定断言处理。这些是已知表达的护栏，不是通用语义蕴含判断；引用存在不等于语义支持已经得到普遍验证。

Planner/Synthesis 血缘写入 exploration step 的 metadata；Revision 血缘写入纠正来源的 `sourceMeta.generation`，与产出 revision IDs 同事务落盘。指纹对应实际发送给模型的输入，包括重试约束；处理版本与重试原因可还原。

Start/Respond 返回 `save_ms`，Continue 分开返回 `planner_ms`/`synthesis_ms`，修订单列 `revision_ms`。`save_ms` 从服务方法入口计到事务内构造响应，不包含幂等结果写入、事务 commit 或客户端网络往返；其余分段覆盖模型调用与校验重试，不含发布事务，不能把它们当作客户端 ACK 或体验 SLA。

固定合成评测保留 Ask/Stop、问题目标、信息增益、反例和证据可追溯的预期；测试代码负责可重复执行。真实 Planner 候选评测不代表数据库发布、Final Synthesis 或 Revision 的模型质量已获证明。

## 报告目标、回传与来源重绑

本节说明已实现的 Core 桥接，不扩展普通对话能力。机器契约以 `packages/core/src` 中的 CoreReportTarget、CoreReportTransferInput、UnderstandingSourceRebind 为源，行为见 `apps/api/src/core/report-bridge.ts` 和 `routes/core.ts`。

- 创建探索的可选 `report_target` 绑定 baseline_version、input_hash、domain、report_version，以及可选 finding_key/question；服务端核对当前报告和判断。目标过期返回 `STALE_REPORT_VERSION`，问题漂移为 `STALE_EXPLORATION_CONTEXT`，判断不存在为 `FINDING_NOT_FOUND`，不默换目标。
- `GET /api/core/capabilities` 返回 native_core 与 report_bridge；有 adapter 时先按当前身份读取，只有实现 `sourceLifecycle: true` 的桥可用。能力声明不是模型或发布已就绪。
- `POST /api/core/explorations/:id/report-feedback` 从已保存探索读取选定 source_id、assessment_version、content_hash；校验归属、报告与来源版本，再以 supplement 保存。服务端生成稳定 `core-report:` 键，跨 HTTP 重试或回执丢失保持幂等；不修改 Core 事件或调用模型。原文为空或超出回传边界会拒绝，不能截断。保存成功不表示已处理/发布。
- `POST /api/core/report-sources/rebind` 接收重绑请求；替代来源正文、哈希与归属由服务端取，adapter 在锁内再核对最新目标。客户端不能自报绑定文本。重绑不能自动恢复旧审核或当前认识。

缺桥返回 `REPORT_BRIDGE_UNAVAILABLE`；来源变动为 `STALE_REPORT_SOURCE`。定向证据在 `core-report-bridge.test.ts`、`core-report-temporal.test.ts` 与账号生命周期集成用例；真实部署往返仍单独验证。可靠性契约引用本节，避免平行维护桥接口。
