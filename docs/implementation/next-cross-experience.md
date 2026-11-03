# 跨事件当前认识 — 待决设计

> 本文保留完整跨事件综合的设计问题。当前 AV 本人内测已按 [T1-R2 最小契约](t1-r2-cross-experience.md) 收口必要规则；本轮范围与验收以 [AV 内测契约](av-dogfood-v0.1.md) 为准。剩余完整能力仍按 Roadmap 进入，不把本问题清单当作全量开工授权。

## 1. 设计问题

当前的 `GET /api/core/understanding` 本质上还是：

> 汇总多个 exploration 里各自的 current claim。

它还不是 FindMe 最终需要的：

> **跨多个 Experience、时间、场景、支持证据和反例，形成一份可解释、可修订的“当前的我”。**

示例：

```text
Experience A
  → “信息不充分时，我倾向先观察”

Experience B
  → 同类支持

Experience C
  → 信息充分时我会立即表达
  → 形成反例 / scope 收窄

Experience D
  → 半年后行为发生变化

                ↓

Cross-Experience Current Understanding
  → 当前模式是什么
  → 只在哪些场景成立
  → 哪些是反例
  → 过去与现在是否不同
  → 为什么当前仍保留/降低/撤回这条认识
```

如果不补这一层，FindMe 会逐渐变成“很多次很聪明的单事件分析”，而不是持续形成和修订个人认识。

## 2. 目标 outcome

下一阶段暂称：

> **T1-R2 — Cross-Experience Current Understanding**

目标不是生成更长的画像，而是让系统可以回答：

1. 当前有哪些认识值得跨事件保留？
2. 每条认识由哪些独立 Experience 支持？
3. 有哪些挑战它的反例？
4. 适用范围是什么？
5. 它是否只属于过去某段时间？
6. 为什么现在仍然成立、需要收窄、进入争议或撤回？
7. 新 Source/Experience/Correction 到来时，哪些 current views 需要重算？

## 3. 编码前待决设计

恢复开发后，**第一步不是写代码**。先形成新的精简实施设计，至少冻结以下问题。

### 3.1 Claim identity

必须先解决：

> 两个 exploration 里的 claim，什么时候是“同一个认识的不同证据”，什么时候是两个不同认识？

不能只靠文本相似度或 LLM 临场判断。

至少需要设计：

- cross-experience claim identity / semantic key；
- scope 维度；
- time range；
- claim kind / mode；
- merge / split / supersede 规则；
- 对旧 claim key 的兼容方式。

### 3.2 Evidence independence

T1-R1 已用 `independence_group = experience:<id>` 避免同一事件多句话被当成多个独立事件。

跨事件层需要继续明确：

- 同一 Experience 的多轮回答仍算一个独立事件；
- 同一事件的摘要/模型解释不增加独立支持；
- imported source 与 native event 是否来自同一底层事件；
- 多角色解释不是新的事实证据；
- correction 是新信息还是仅修订旧解释。

### 3.3 Support / challenge / contextualize 聚合

禁止简单“支持票数 - 反例票数”。

要定义：

- directness；
- applicability；
- scope match；
- temporal relevance；
- source eligibility；
- independence；
- contradictory evidence；
- alternative explanations。

聚合结果应该能说明“为什么当前这样理解”，而不是输出黑箱分数。

### 3.4 时间与状态

必须区分：

- 过去成立，现在变化；
- 同一时期不同 context 下不同表现；
- 一次异常状态；
- 原先就误读。

不能把“现在不同”统一处理成旧来源失效。

### 3.5 Synthesis trigger

需要决定什么时候更新跨事件认识：

候选触发：

- 新 Experience 完成；
- ClaimRevision；
- SourceAssessment 改变；
- 用户手工要求重新评估；
- 时间窗口变化。

需要避免：

- 每次页面刷新都调 LLM；
- unrelated change 导致全量重算；
- 旧 generation 在新 revision 后覆盖回来。

### 3.6 Dependency propagation

T1-R1 已解决 Source → ClaimRevision。

下一层要进一步明确：

```text
SourceAssessment
  ↓
EvidenceSpan / ClaimEvidence
  ↓
Experience-level ClaimRevision
  ↓
Cross-Experience Synthesis
  ↓
Current Self View
```

每层需要：

- version；
- dependency fingerprint；
- stale/invalid；
- publish precondition。

### 3.7 Current Self View UI

目标页面不应该变成传统人格报告。

第一轮设计建议仍保持方案 C 的结构：

- 当前认识
- 适用范围
- 为什么目前这样理解
- 支持经历
- 反例 / 挑战
- 仍不知道什么
- 最近发生了什么变化

需要回答：

- 首页展示多少条？
- 多条认识如何分组？
- 三观何时开始自然出现？
- stale / contested 如何呈现？
- 用户如何进入“这条认识是怎么来的”？

### 3.8 Claim Replay / Counterexample Replay

跨事件模型不能只靠“看起来更完整”的画像文案验收。D1 必须给固定 synthetic fixtures 定义 replay：在一个已有 current claim 上依次加入新 Experience / Correction / SourceAssessment，检查系统能否稳定说明该材料是 `supports / challenges / contextualizes / unrelated`，以及当前认识应保持、收窄、进入 contested、待复核或撤回。

Replay 的目的不是要求 LLM 每次输出逐字相同，而是验证相同 policy/version/input 下的**状态边界和证据血缘**不漂移：不合格来源不能因语言相似重新进入；同一事件多轮不能增加独立支持；可靠反例能够影响全称 scope；过去成立/现在变化不能被误作旧事实错误；无关事件不能触发全量重算。

程序负责 eligibility、independence、version/stale、依赖范围与允许的状态迁移；模型只负责候选语义关系、scope/alternative explanation 和可读 change summary。Replay fixture 同时记录 Epistemic Policy / prompt / model / validator 版本，避免把处理版本变化误判成“用户变了”。

## 4. 建议实施顺序

恢复开发后按以下顺序，不直接把本文件当 WBS 交给编码 Agent。

### Phase D1 — Detailed Design

产出：

- `docs/implementation/t1-r2-cross-experience.md`
- domain changes
- state/version/dependency rules
- API contracts
- deterministic acceptance fixtures
- claim replay / counterexample replay fixtures
- Epistemic Policy / prompt / model / validator versioning contract
- migration/backfill/rollback design

owner review 后才进入编码。

### Phase D2 — Backend synthesis foundation

可能涉及：

- cross-experience claim identity；
- synthesis/current-view persistence；
- dependency fingerprints；
- support/challenge links；
- stale propagation；
- synthesis service。

是否新增表，以 D1 设计为准，不在本 handoff 提前决定。

### Phase D3 — Deterministic + model-assisted synthesis

程序负责：

- eligibility；
- dependency graph；
- version/stale；
- evidence independence；
- conflict checks。

模型只负责：

- 候选聚合；
- scope 表述；
- alternative explanations；
- human-readable change summary。

模型不能自行决定哪些来源有资格参与。

### Phase D4 — Current Self View API + App

至少支持：

- current;
- contested;
- stale / needs review;
- evidence / counterevidence；
- change history。

### Phase D5 — Dogfood validation

用新的真实 Experience 连续使用，而不是一次性 synthetic success。

重点观察：

- 是否产生重复/同义 claim；
- scope 是否越来越准确；
- 反例是否真的能收窄认识；
- 系统是否过早上升成人格判断；
- Current Self View 是否比单次事件结果增加价值；
- 固定 Claim Replay 中反例、时间变化、来源更正是否产生预期状态边界，而不是仅改变文案。

## 5. 非目标

在 T1-R2 之前或期间，不顺带实现：

- 全量历史聊天导入；
- legacy → Core 全量迁移；
- 多角色角色库；
- T2 Action/Experiment；
- 完整三观报告；
- 正式多用户开放；
- 社交匹配；
- graph database；
- 通用向量检索平台；
- 组织后台。

这些不能作为“顺便一起做”的理由扩大下一批。
