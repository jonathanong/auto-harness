# Agent guide — Auto Harness

Conventions for humans and coding agents working in this repository.

## Layout

| Path         | Role                                                       |
| ------------ | ---------------------------------------------------------- |
| `modules/*`  | Shared libraries (`@auto-harness/*`). No deployables.      |
| `services/*` | Deployable / runnable units: `api`, `agent`, `web`, `cdk`. |
| `docs/*`     | Product and design docs (source of truth for behavior).    |

**Import rules (enforced by dependency-cruiser):**

- `modules/*` may import other modules and npm packages only.
- `services/*` may import `modules/*` and npm packages only.
- **No service may import another service.** Share code via modules.

Product sequencing and locked decisions: [docs/plan.md](docs/plan.md).

## Tooling

| Command                       | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `pnpm install`                | Install workspace                                                                |
| `pnpm lint`                   | oxlint                                                                           |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt                                                                            |
| `pnpm test`                   | vitest with **100%** coverage thresholds                                         |
| `pnpm knip`                   | Unused exports/deps                                                              |
| `pnpm depcruise`              | Architecture import boundaries                                                   |
| `pnpm links`                  | lychee markdown link check                                                       |
| `pnpm check`                  | Full local CI gate                                                               |
| `pnpm test:e2e`               | Build production UIs + Playwright E2E (`next start`; [docs/e2e.md](docs/e2e.md)) |
| `pnpm local:e2e`              | Phase 1 create→run on a temp git repo                                            |
| `pnpm local:api`              | Local API on `:7420` (Node + DynamoDB)                                           |
| `pnpm local:web`              | Control-plane Next.js UI on `:7421`                                              |
| `pnpm local:agent-web`        | Agent-pane Next.js UI on `:7422`                                                 |
| `pnpm local:dynamodb`         | DynamoDB Local on host `:7423`                                                   |
| `pnpm local:agent`            | Agent CLI (`status`, `run-session`)                                              |
| `pnpm local:tmux`             | Above (minus DynamoDB, which stays in Docker), one tmux window each              |

Package manager: **pnpm** only (see `packageManager` in root `package.json`). Local runbook: [docs/local-development.md](docs/local-development.md). **Pre-deploy E2E:** [docs/agent-e2e-testing.md](docs/agent-e2e-testing.md). **Deploy:** [docs/deploy.md](docs/deploy.md) → [local](docs/deploy-local.md) / [AWS](docs/deploy-aws.md) / [agent](docs/deploy-agent.md).

## Testing

- Framework: **vitest**.
- Coverage: **100%** lines, branches, functions, statements on `modules/*/src` and `services/*/src` (excluding pure type files like `types.ts`, `session.ts`, thin `**/cli.ts`, and `*.test.ts`).
- **Mock only host CLI boundaries** (`child_process`, `node-pty`, and similar “run a CLI tool” adapters). Prefer real modules, in-memory fakes, and pure functions for everything else.
- Do not lower coverage thresholds to land incomplete code.

## TypeScript / runtime

- **No `tsc` build.** Sources are executed with **Node native type stripping** (`node file.ts`). Requires **Node.js ≥ 22.18**.
- Relative imports use **`.ts` extensions** (what Node resolves at runtime).
- Avoid TypeScript features Node cannot strip (enums, namespaces, parameter properties). Prefer plain fields assigned in the constructor.
- Strict mode via `tsconfig.base.json` for editors (`noEmit`, `allowImportingTsExtensions`).
- `"type": "module"` / NodeNext resolution.
- Prefer small pure modules in `modules/shared` before adding service code.

## Docs

- Read `docs/` before inventing behavior.
- Update docs when behavior changes.
- Repo harness hookup examples: [docs/harness.md](docs/harness.md).

## CLAUDE.md

Root `CLAUDE.md` only points here so every agent stack shares one guide.
