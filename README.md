# FindMe

English | [简体中文](README.zh-CN.md)

FindMe is being built toward a cyber counterpart (赛博分身): a silicon-based other self that develops a continuing understanding of a person's experiences, circumstances, values, and ways of thinking, while offering independent and sufficiently objective judgment. Its core value is to help the person understand themselves, find support and useful advice, and examine self-justification, self-criticism, or the system's own misunderstandings using personal evidence and relevant academic knowledge.

Conversation, guided exploration, learning, feedback, and importing personal material are ways to build and revise that understanding. Reports and personal-development assessments make parts of it readable and usable. Users can start with a concrete experience or an easy question, without a large archive or a personality label. The future implementation form remains open; an agent plus a personality-distillation Skill is only one possible approach, not a committed architecture.

The [first-stage scope](docs/delivery/phase-1-personal-understanding.md) is a usable foundation: a current personal understanding that can be read, discussed, corrected, and genuinely updated by new information in one persistent app. Existing Core and account-mode code provide substantial reusable parts, but code, local synthetic regression results, deployment, model quality, and personal usefulness have different validation states. See [As-Is](docs/as-is.md) before treating a capability as available or the first stage as complete.

## Repository map

This pnpm monorepo contains:

- `apps/app/` — the sole React 19 + Vite browser SPA, shared by desktop and mobile H5
- `apps/api/` — API and processing services
- `packages/core/`, `packages/db/`, `packages/shared/` — domain logic, database schema, and shared contracts
- `docs/` — product and architecture references, implementation contracts and command guidance

The independent `apps/web` and `apps/miniapp` clients have retired from the repository under [ADR D25](docs/adr.md#d25-直接退役两个独立客户端统一使用-appsapp-浏览器入口). Legacy runtime modes, Cloudflare/Neon paths and their tables have since been removed; the app runs as a single node. This does not establish first-stage acceptance. See [As-Is](docs/as-is.md) for the source-backed implementation boundary.

## Development entry points

The repository declares Node.js 22+ and pnpm 9.15.9 in `package.json`. Install the locked dependencies with:

```bash
pnpm install --frozen-lockfile
```

The root scripts include `pnpm dev:app`, `pnpm dev:api`, `pnpm build`, and `pnpm test`. Use `pnpm test:local` for DB-free synthetic regression and `pnpm test:db` for automatically provisioned disposable PostgreSQL; use `pnpm test:fast` for focused feedback and `pnpm test:app` for App units. Unfiltered `pnpm test` also runs synthetic/real browser groups and requires Docker plus Chromium (`pnpm exec playwright install chromium`). Scope and uncovered layers are documented in the [first-phase test plan](docs/delivery/phase-1-test-plan.md). Before starting a service or running database-related commands, follow [Commands](docs/commands.md) for configuration and side-effect details. For dependency setup and local preview guidance, see [Development environment](docs/implementation/development-environment.md).

## Self-hosting

A single-node deployment (web app, API, background worker and PostgreSQL in Docker Compose, built from source on the target server) is described in [deployment/standalone](deployment/standalone/README.md). Model inference stays off until you configure your own provider credentials and budgets.

## Documentation

- [Overview](docs/overview.md) — product direction and boundaries
- [First-stage scope](docs/delivery/phase-1-personal-understanding.md) — required outcomes and observable acceptance criteria
- [As-Is](docs/as-is.md) — behavior currently supported by source code
- [Roadmap](docs/roadmap.md) — future work and entry conditions
- [Commands](docs/commands.md) — development, validation, and operations commands
- [BA](docs/ba.md), [AA](docs/aa.md), [DA](docs/da.md), and [TA](docs/ta.md) — business, application, domain, and technical architecture
- [Implementation contracts](docs/implementation/) — detailed behavior and integration boundaries
- [Assets](assets/README.md) — brand and interface assets

Use the product and architecture documents for intended behavior, As-Is for implemented behavior and the Roadmap for what remains. This README is an orientation page; it does not claim that planned capabilities are complete.


See the [debt ledger](docs/delivery/debt-resolution.md) and [first-stage acceptance record](docs/delivery/acceptance.md). Local development configuration is in [Development environment](docs/implementation/development-environment.md#本机开发配置); legacy seed assets are not a prerequisite for an account with no imported history.

## License

FindMe is licensed under the [GNU Affero General Public License v3.0](LICENSE).
