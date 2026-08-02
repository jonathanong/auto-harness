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

| Command                       | Purpose                                  |
| ----------------------------- | ---------------------------------------- |
| `pnpm install`                | Install workspace                        |
| `pnpm typecheck`              | TypeScript project references build      |
| `pnpm lint`                   | oxlint                                   |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt                                    |
| `pnpm test`                   | vitest with **100%** coverage thresholds |
| `pnpm knip`                   | Unused exports/deps                      |
| `pnpm depcruise`              | Architecture import boundaries           |
| `pnpm links`                  | lychee markdown link check               |
| `pnpm check`                  | Full local CI gate                       |

Package manager: **pnpm** only (see `packageManager` in root `package.json`).

## Testing

- Framework: **vitest**.
- Coverage: **100%** lines, branches, functions, statements on `modules/*/src` and `services/*/src` (excluding pure type files like `types.ts` and `*.test.ts`).
- **Mock only host CLI boundaries** (`child_process`, `node-pty`, and similar “run a CLI tool” adapters). Prefer real modules, in-memory fakes, and pure functions for everything else.
- Do not lower coverage thresholds to land incomplete code.

## TypeScript

- Strict mode via `tsconfig.base.json`.
- `"type": "module"` / NodeNext resolution.
- Prefer small pure modules in `modules/shared` before adding service code.

## Docs

- Read `docs/` before inventing behavior.
- Update docs when behavior changes.
- Repo harness hookup examples: [docs/harness.md](docs/harness.md).

## CLAUDE.md

Root `CLAUDE.md` only points here so every agent stack shares one guide.
