# FindMe App

唯一浏览器客户端 `apps/app`：React 19 + Vite 单页应用（SPA），手机 H5 与桌面共用代码；不是原生安装包。独立 `apps/web`、`apps/miniapp` 按 [ADR D25](../../docs/adr.md#d25-直接退役两个独立客户端统一使用-appsapp-浏览器入口) 退役；静态/私有入口与 Dogfood 页也已移除，账号模式是唯一入口。桌面与 390×844 移动浏览器套件见下文，测试通过不等于 P1 接受。

The product vision is the continuously developing cyber counterpart described in [Overview](../../docs/overview.md). This client serves the [first-stage scope](../../docs/delivery/phase-1-personal-understanding.md): reading, discussing, correcting, and updating one current personal understanding. Conversation, learning, and imports contribute to that understanding; reports are readable outputs. The entry modes below describe existing code, not a claim that this entire scope or a complete counterpart is available.

## Entry modes

| Entry | How it is selected | Status |
| --- | --- | --- |
| Account App | default (`CloudWorkspace`) | The only runtime entry: login, Profile, topics/reports, evidence, responses, processing confirmation, history, data export, frameworks, source-backed knowledge, book perspective, action trials and model settings |
| `/diagnostic-preview` | path, development server only | Synthetic reading prototype; no API or model calls; not in production builds |

Implemented behavior and limits are described in [As-Is](../../docs/as-is.md).

## Development

```bash
pnpm dev:app
```

`VITE_CORE_API_BASE` sets the API origin (see `.env.example`). For previews without production connections, follow [Development environment](../../docs/implementation/development-environment.md).

Brand baseline is B per [ADR D14](../../docs/adr.md#d14-b-方向交叠椭圆作为品牌与界面基线): `src/FindMeMark.tsx`, `src/styles.css` and `public/` contain the implemented mark, styles and icons. `assets/brand/v0.1.0/` is the historical Open Frame candidate. Its token CSS remains imported by `src/styles.css`, and its old mark is used by the synthetic diagnostic preview; those references remain intentional until explicitly replaced.


## Frontend regression tests

- `pnpm --filter @findme/app test`: HTTP identity-boundary unit regressions.
- `node scripts/test-browser.mjs synthetic`: production-built account React App with intercepted synthetic API responses. This checks interactions, not actual authentication, persistence or model quality.
- `node scripts/test-browser.mjs real`: the same App through a loopback test-only `createApp` host, real Better Auth cookies and disposable PostgreSQL roles created by `scripts/test-db.mjs`. Each viewport receives a fresh database while production rate limits remain unchanged. Identity is synthetic, mail is disabled and no product gateway is configured. Reports remain unavailable until actual processing exists.
- `node scripts/test-browser.mjs all`: both browser groups. Install the root Playwright dependency and its Chromium first (`pnpm exec playwright install chromium`; on Ubuntu CI, `pnpm exec playwright install --with-deps chromium`). Docker is required for the real group.

The runner strips application/model/database environment variables, does not load `.env`, builds account mode without private tools, and refuses occupied test ports rather than reusing existing services. Playwright owns its HTTP child; the outer runner cleans the disposable database on failure or interruption. These checks do not deploy or access production services.
