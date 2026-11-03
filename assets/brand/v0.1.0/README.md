# FindMe Brand Assets v0.1.0

Status: **historical, superseded by B**. Retained as the Open Frame candidate record per [ADR D14](../../../docs/adr.md#d14-b-方向交叠椭圆作为品牌与界面基线). Current mark implementation: `apps/app/src/FindMeMark.tsx`; current icons: `apps/app/public/`. The package still contains current compatibility dependencies: the main App imports `tokens/brand-tokens.css`, and the synthetic diagnostic preview imports `logo/findme-mark.svg`. Superseded brand direction does not mean every file is unused.

## Historical selected concept

**Open Frame / Logo A** — four open corners + a central point. This was the topology selected before B; it is no longer the refinement baseline. The open frame represents a structured but revisable understanding; the center represents focus/finding, not a permanent label.

## Tagline

- 中文：`看清自己。`
- English: `See Yourself Clearly.`

Product proposition: `从真实经历出发，持续修订对自己的理解，做更自主的选择。`

## Structure

- `logo/` — vector mark and lockup references.
- `icons/` — vector/raster app-icon candidates and small-size marks.
- `tokens/` — brand and semantic tokens.
- `reference/` — design-board references; visual reference only, not executable UI specs.

## Usage notes

- UI uses sans-serif as the default; serif is reserved for reflection/editorial emphasis.
- Observation, evidence, interpretation, uncertainty, correction, counter-evidence and action are separate semantic states.
- The logo mark is not a scanner/camera control and should not be animated like a targeting reticle.
- Product implementation remains governed by [统一 App 契约](../../../docs/implementation/av-understanding-app-delivery.md) and [B 方向设计规范](../../../design-demos/spec.md); this package does not imply that the UI has already been implemented.
