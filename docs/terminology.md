# Terminology

Canonical vocabulary for UI copy, nav labels, docs, and `data-pw` selectors. When naming something new or renaming something existing, check here first — and update this file when the vocabulary changes.

The short version: **a "Host" runs "Sessions".** Never call either one an "agent" in UI-facing text — "agent" is reserved for the underlying identifier/process (see below).

---

## UI-facing terms

| Term                | Meaning                                                                                                                                                                                         | Where it shows up                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Host**            | A machine/daemon that registers with the control plane (identified by `agentId`), can be online/offline, drained, and owns host inventory.                                                      | Control plane `/hosts` page; "Add host", "Drain"                |
| **Session**         | A single Claude/Codex/etc. CLI invocation running against a worktree on a host. This is what people colloquially call "an agent" — in this codebase it is always a **session**, never an agent. | `/sessions`, session status, logs                               |
| **Repository**      | A git repo registered in the control-plane catalog, optionally with a host path attached.                                                                                                       | `/repositories`                                                 |
| **Worktree**        | A git worktree under a repository on a specific host, where sessions actually run.                                                                                                              | `/worktrees`, worktree detail pages                             |
| **Host inventory**  | The repositories + worktrees + command profiles configured for a given host.                                                                                                                    | Agent pane Repositories/Worktrees pages, "Add repository" modal |
| **Command profile** | A named, fixed `argv` (never a free-form shell string) a session can run.                                                                                                                       | Host inventory, session create form                             |

## Deliberately still "agent" (not renamed)

These are internal/API-level names, not UI copy. Renaming them would touch identity, env vars, CLI commands, and wire protocol — out of scope for the UI terminology cleanup. If you're writing UI-facing text, translate these to the terms above; if you're touching the underlying system, leave the names below alone.

| Name                                                          | Why it stays "agent"                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agentId` / `HARNESS_AGENT_ID`                                | The stable identity a host registers under. Renaming is a breaking wire/env change.                                                                                                              |
| `pnpm local:agent`, `services/agent/*`                        | The daemon/CLI package that runs _on_ a host and connects to the control plane.                                                                                                                  |
| **Agent pane** (`services/agent-web`, `pnpm local:agent-web`) | The per-host local UI for managing that host's own inventory. Still says "agent" — a full rename of this surface wasn't in scope when `/hosts` was renamed; revisit if it becomes confusing too. |
| `/api/v1/agents/*`, `/api/v1/agent-hosts`                     | REST routes. Renaming would be a breaking API change.                                                                                                                                            |

---

## Related

- [local-development.md](local-development.md) — ports, commands, the two UIs
- [e2e.md](e2e.md) — `data-pw` selector conventions
- [agent.md](agent.md) — agent daemon internals (the _process_, not the UI concept)
