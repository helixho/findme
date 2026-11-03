# 第一阶段业务接受记录

有效依据为 [P1-AC-01–09](phase-1-personal-understanding.md)，旧 owner-entry-v1 的十条 AC 与 G1 不转为本阶段通过。本文保留未执行状态，Agent 不代写本人体验。工程检查、部署运行、真实回答质量与本人效用分别记录。

三类证据分开记录：工程证据是可重复的合成测试，只说明代码行为；模型证据需要真实模型运行，当前模型调用关闭，全部未执行；本人证据只能由本人提供。没有本人反馈的条件一律保持未接受。

| 条件 | 工程证据（合成） | 模型证据 | 本人证据 | 状态 |
| --- | --- | --- | --- | --- |
| P1-AC-01 | `e2e/real.spec.ts`（真实账号刷新后保存仍在）、`scripts/verify-standalone.mjs`（部署后读写与重启保留） | 未执行 | 未执行 | 未接受 |
| P1-AC-02 | `cloud-account-integration.test.ts`（报告与依据读取）；全量材料的去向未贯通 | 未执行 | 未执行 | 未接受 |
| P1-AC-03 | `core-reliability.test.ts`、`core-prior-understanding-postgres.test.ts` | 未执行 | 未执行 | 未接受 |
| P1-AC-04 | `core-prior-understanding-postgres.test.ts`、`account-core-model-postgres.test.ts`；诊断报告与知识专题不随对话更新，见 [As-Is §15](../as-is.md#15-三条理解路径的现状关系) | 未执行 | 未执行 | 未接受 |
| P1-AC-05 | `core-reliability.test.ts`、`cloud-account-integration.test.ts`（来源生命周期）、`personal-sources-postgres.test.ts`（更正替代与排除） | 未执行 | 未执行 | 未接受 |
| P1-AC-06 | 无（需要真实回答） | 未执行 | 未执行 | 未接受 |
| P1-AC-07 | `knowledge-processing-postgres.test.ts`、`specialist-postgres.test.ts`、`specialist-trial-review.test.ts` | 未执行 | 未执行 | 未接受 |
| P1-AC-08 | `export-restore-continuity.test.ts`、`standalone-files.test.ts`、`personal-sources-postgres.test.ts`（原档来源） | 未执行 | 未执行 | 未接受 |
| P1-AC-09 | 无（需要本人完整使用） | 未执行 | 未执行 | 未接受 |

各条件需要的实际证据见[第一阶段范围](phase-1-personal-understanding.md)。实际执行时记录候选提交、运行入口、相关版本/来源标识、操作与观察、失败/未测项和本人原意的反馈；私人正文不放入仓库。未通过则保留具体问题，不用“有页面”或合成回归代替接受。
