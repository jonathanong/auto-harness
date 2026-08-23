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

| Command                       | Purpose                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                | Install workspace                                                                                                                             |
| `pnpm lint`                   | oxlint                                                                                                                                        |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt                                                                                                                                         |
| `pnpm test`                   | vitest — unit + integration projects, with 99/99/99/99 aggregate coverage thresholds                                                          |
| `pnpm test:unit`              | vitest, unit project only                                                                                                                     |
| `pnpm test:integration`       | vitest, integration project only (real HTTP+WS+daemon+git)                                                                                    |
| `pnpm test:platform`          | Focused native host-daemon tests used by macOS/Windows CI                                                                                     |
| `pnpm knip`                   | Unused exports/deps                                                                                                                           |
| `pnpm depcruise`              | Architecture import boundaries                                                                                                                |
| `pnpm links`                  | lychee markdown link check                                                                                                                    |
| `pnpm check`                  | Full local CI gate                                                                                                                            |
| `pnpm check:no-mistakes`      | no-mistakes rules (Playwright `data-pw`, Next.js, repo hygiene)                                                                               |
| `pnpm test:e2e`               | Build production UIs + Playwright E2E (`next start`; [docs/e2e.md](docs/e2e.md))                                                              |
| `pnpm local:e2e:isolated`     | Isolated e2e in this worktree's own port range + DynamoDB container (multi-worktree safe; see `pnpm local:e2e:isolated -- <playwright args>`) |
| `pnpm local:e2e`              | Phase 1 create→run on a temp git repo                                                                                                         |
| `pnpm local:api`              | Local API on `:7420` (Node + DynamoDB)                                                                                                        |
| `pnpm local:web`              | Control-plane Next.js UI on `:7421`                                                                                                           |
| `pnpm local:host-pane`        | Host-pane Next.js UI on `:7422`                                                                                                               |
| `pnpm local:dynamodb`         | DynamoDB Local on host `:7423`                                                                                                                |
| `pnpm local:daemon`           | Agent CLI (`status`, `run-session`, `start`, `install-service`, `uninstall-service`)                                                          |
| `pnpm local:tmux`             | Above (minus DynamoDB, which stays in Docker), one tmux window each                                                                           |

Package manager: **pnpm** only (see `packageManager` in root `package.json`). Local runbook: [docs/local-development.md](docs/local-development.md). **Pre-deploy E2E:** [docs/host-daemon-e2e-testing.md](docs/host-daemon-e2e-testing.md). **Deploy:** [docs/deploy.md](docs/deploy.md) → [local](docs/deploy-local.md) / [AWS](docs/deploy-aws.md) / [agent](docs/deploy-host-daemon.md).

## Working in a git worktree, or alongside other agents

This repo is regularly checked out into several git worktrees at once, each possibly running its
own agent, dev server, or e2e run concurrently. **Never guess a port offset or reuse another
run's DynamoDB container by hand** — two worktrees on the same fixed ports silently corrupt each
other's runs, or point a stale build at the wrong backend. Use
[`scripts/worktree-e2e-env.mts`](scripts/worktree-e2e-env.mts) (`pnpm local:e2e:isolated`; see
[docs/e2e.md#isolated-focused-control-runs](docs/e2e.md#isolated-focused-control-runs)) — it
derives a deterministic, worktree-specific port block from the worktree's own directory name and
probes it for real collisions before use, so concurrent worktrees don't collide and the same
worktree gets stable, reusable ports across runs.

## Testing

- Framework: **vitest**, one config (`vitest.config.ts`) with two `test.projects`: **unit** (`modules/`, `services/`, `scripts/`) and **integration** (`integration/`, real HTTP+WS+daemon+git — see [docs/host-daemon-e2e-testing.md](docs/host-daemon-e2e-testing.md)).
- Coverage: Vitest enforces aggregate thresholds of **lines 99 / branches 99 / functions 99 / statements 99** on `modules/*/src/**/*.{ts,tsx}` and `services/*/src/**/*.{ts,tsx}`; CI uses `coverage-check` to enforce **99% patch line coverage** from aggregate plus supplemental LCOV and the exact event base SHA. `.coverage-rules.yml` is the authoritative scope/disposition source (tests, `*.d.ts`, type-only syntax, thin CLIs, re-export barrels, unfinished Dynamo adapter splits); `vitest.config.ts`, `coverage-check/vitest`, and the patch checker all consume it. New source is included by those globs — do not add per-file include/threshold allow-lists. `services/host-daemon/src/cli.ts` is measured (thin `services/{api,cdk}/src/cli.ts` are not). Aggregate-excluded executable files receive supplemental patch coverage without joining the aggregate denominator. The integration project carries no coverage gate of its own. Four critical Dynamo adapter files retain a separate exact-coverage verifier.
- **Mock only host CLI boundaries** (`child_process`, `node-pty`, and similar “run a CLI tool” adapters). Prefer real modules, in-memory fakes, and pure functions for everything else.
- Do not lower the 99% project-function or patch coverage targets to land incomplete code.

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
- UI-facing vocabulary (what to call things in nav labels, copy, `data-pw` ids): [docs/terminology.md](docs/terminology.md).
- Repo harness hookup examples: [docs/harness.md](docs/harness.md).

## Operator-editable configuration

- Every supported persisted setting that an operator can edit must have a structured control-plane
  UI. A raw JSON editor may exist for bulk or debug workflows, but it must never be the only way to
  configure a supported setting.
- Machine-facing JSON APIs/files and daemon-advertised runtime capabilities are not operator UI
  settings and do not require duplicate form controls.

## CLAUDE.md

Root `CLAUDE.md` only points here so every agent stack shares one guide.
