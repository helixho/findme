# 第一阶段主链：当前理解进入下一次交流

> 本文是[交付计划](diagnostic-product-plan.md)工作包 2 的产品侧差异设计，以及工作包 4 首条主链的实现契约。依据为[第一阶段范围](../delivery/phase-1-personal-understanding.md)与 [ADR D26](../adr.md#d26-对话使用-core-当前认识并自动处理新输入)。实际实现见 [As-Is](../as-is.md)，不在此保存测试数字或部署状态。

> 本文记录既有主链的具体实现契约。新的多步取证和方法执行按[Agent 设计](personal-understanding-agent.md)与[工作计划](../delivery/agent-work-plan.md)适配；下文固定步骤和调用上限继续描述原实现，不是新 harness 的强制执行形式。来源、版本、修订与实际预算要求继续有效。

## 1. 要解决的断点

改动前，一次探索只读取**本次探索**的认识和**同一经历**的证据。其他经历形成的当前认识不参与提问和综合。另外，账号模式的 Core 端点不调用模型，账号 App 也没有对话入口。所以 P1-AC-03/04/05 所要求的“已有理解减少重复说明、新输入影响下一次回答”在正式入口不成立。

## 2. 设计决定（差异部分）

| 设计问题 | 本轮结论 |
| --- | --- |
| 对话使用哪一份理解 | 只用 Core 当前有效的 ClaimRevision（`status=current` 且 `evidence_status=valid`），跨经历有界选取；诊断报告和知识专题只用于呈现与导航，不作为第二个回答依据（D26） |
| 怎样选取 | 版本化选择器 `prior-understanding-selection@v1`：按词面相关度排序；无词面相关时最多补 2 条最近认识，并标为“可能无关”；有条数与字数上限；排除本次探索自己的认识 |
| 已撤回或失去依据的认识 | 不进入可用列表，单独作为“不得作为前提”提供给模型，并在血缘中记录 |
| 新输入怎样进入认识 | 先保存（沿用 Start/Respond 快写），处理时由模型对每条相关的已有认识给出一个效果：`unchanged / supports / narrows / challenges`；确定性校验通过后才写入 |
| 效果怎样落到认识上 | `supports`、`narrows`、`challenges` 都为**原认识**新建一个 ClaimRevision：继承旧证据，新增本次经历作为独立证据组；`narrows` 改写适用范围（可选改写文字），`challenges` 不改写文字，只下调一级依据强度并保留挑战证据；`unchanged` 不写入 |
| 处理结果是否可见 | 每次处理返回并持久化 `processing.result`（`revised / challenged / added / supported / unknown`）和逐条 `prior_effects`；允许“不变”或“未知”，但必须说明 |
| 并发 | 写入前锁定原修订；若它已不是当前有效版本，该效果记为 `skipped_stale`，不覆盖新的有效状态 |
| 删除 | 硬删除某认识的来源时，其他探索中把它用作上下文的步骤、问题和助手追问（含复制的文字和据此生成的读数），以及该认识的撤回副本都一并清理；这类认识不再进入任何上下文；提交前检查本次用到的认识没有被删除，并与删除串行执行 |
| 自动处理与费用 | 账号模式自动处理（D26），受两层限制：每次操作最多 4 次模型请求（规划、综合各最多 2 次尝试，账号路由关闭网关自身的单次重试，使上限按实际请求计）；每个 Profile 滚动 24 小时的操作上限 `CORE_MODEL_DAILY_OPERATION_LIMIT`，默认 0 即关闭，且需要 `CLOUD_INFERENCE_ENABLED=1` |
| 事务边界 | 账号模式下每次读写各开一个短的 Profile RLS 事务（RLS 即数据库行级权限），模型调用夹在两次事务之间，不在事务内调用；失败操作用原幂等键重新执行时另计一次；计数前按 Profile 取事务级 advisory 锁，避免并发的新请求读到相同已用数而一起越过上限；超限时整次预留回滚，不调用模型，已保存的输入不受影响 |

## 3. 接口与状态衔接

- 实现位置：`apps/api/src/core/prior-understanding.ts` 负责选取、校验、写入和结果判定；`exploration-planning.ts` 中 Continue 的读取、生成、提交通过 `CoreStore` 分成三段；`exploration-revision.ts` 中 Correct 同样分段；账号路由在 `apps/api/src/routes/account-core-model.ts`。
- 契约：`@findme/core` 新增 `PriorUnderstandingUpdate`、`PriorUnderstandingEffect`、`UnderstandingWithPriorDraft`。只有存在已有认识时，综合才使用 `understanding-prior-prompt@v1` 和该输出结构。零历史时提示词字节和输出契约不变。
- 血缘：Ask 与 Stop 步骤的 `model_meta.prior_understanding` 记录实际提供给模型的修订 ID、版本和选取依据；Stop 步骤另记录 `processing`。“下一次回答使用了更新后的版本”可以直接按修订 ID 核对，不靠比对回复文字。
- 账号端点：`GET /api/core/model-status`；`POST /api/core/explorations/:id/continue`、`/correct` 在账号模式启用后调用模型。其他 Core 端点保持原有的无模型路径。
- App：账号版主导航新增“对话”，流程为保存 → 自动处理 → 必要时追问 → 显示处理结果、对已有认识的影响、本次形成的认识、仍不确定的部分 → 纠正或结束。处理失败或超限时提示“已保存”，并提供重新处理（同一幂等键）；收到 202（同一请求仍在处理）时不发起新处理，只提供“刷新状态”。

## 4. 诊断专题与知识专题的关系（本轮只定边界）

两者继续各自承担呈现与加工，不先合并表或接口。知识专题本来就读取 Core 当前 ClaimRevision，因此会随本主链写入的修订自动更新（读取时复核资格）。云端诊断报告依赖的是来源，不依赖 Core 认识；对话新增的来源不会自动进入已发布的报告，报告更新仍走显式处理。是否让报告专题引用 Core 认识，留到工作包 5 结合历史增强评估。

## 5. 本轮不包含

- 运行资源选择、部署、线上入口切换（工作包 3）。
- 知识反馈路径与历史增强（工作包 5），包括作品回应持久化和尝试回顾生成修订。
- 跨专题总览、语义检索（目前只按词面选取）、对其他探索中认识的直接纠正入口（纠正仍在该认识所属的探索内进行）。
- 真实模型下的回答质量和本人效用（工作包 6）。合成网关只能证明数据流、版本和边界正确，不能证明理解得对。
