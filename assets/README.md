# FindMe Assets

Repository-local design assets. These files are versioned references for implementation; generated concept boards outside this repo are not authoritative.

## Current brand baseline

- The brand baseline is the B direction (overlapping ellipses); see [ADR D14](../docs/adr.md#d14-b-方向交叠椭圆作为品牌与界面基线).
- `brand/v0.1.0/` — **Open Frame / Logo A**, a superseded historical candidate kept for reference.
- `brand/v0.1.0/logo/` — exact SVG mark/lockup references.
- `brand/v0.1.0/icons/` — app-icon and small-size raster/vector exports.
- `brand/v0.1.0/tokens/` — brand + semantic token candidates.
- `brand/v0.1.0/reference/brand-foundation-board.svg` — exact vector reference board.
- `ui/t1/reference/t1-core-flow.svg` — historical Scheme C T1 flow reference; its superseded executable prototype has retired.
- Current B mark source: `apps/app/src/FindMeMark.tsx`; public app icons: `apps/app/public/`; design reference: [complete B prototype](../design-demos/full-prototype/index.html).

Current presentation references are the [统一 App 契约](../docs/implementation/av-understanding-app-delivery.md) and [B 方向设计规范](../design-demos/spec.md); retiring the independent clients does not remove the selected B prototype or historical screenshots.

No versioned asset package exists yet for the B direction. The old package is retained as design history, but it is not wholly unused: `apps/app/src/styles.css` still imports its `tokens/brand-tokens.css`, and the synthetic diagnostic preview imports `logo/findme-mark.svg`. These are current build/preview dependencies; do not delete the package as an obsolete whole.
