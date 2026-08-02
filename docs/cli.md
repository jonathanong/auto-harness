# CLI

Operator-facing commands for the VPS agent package (`auto-harness-agent`). Session triggers from CI use the [REST API](api.md), not this CLI.

Install/build: [setup.md](setup.md). Daemon behavior: [agent.md](agent.md).

## Invocation

```bash
npx auto-harness-agent <command> [options]
# or after build:
node services/agent/dist/index.js <command> [options]
```

Config defaults to `./auto-harness-agent.config.json`. Override with `HARNESS_CONFIG_PATH` or env vars (`HARNESS_API_URL`, `HARNESS_API_KEY`, `HARNESS_AGENT_ID`).

---

## Commands

### `start`

Run the agent daemon: connect WebSocket, register worktrees, accept `session:assign`.

```bash
HARNESS_API_URL=wss://… HARNESS_API_KEY=hns_… auto-harness-agent start
```

Foreground process. Production: run under systemd (see [setup.md](setup.md#vps-agent)).

### `status`

Print connection state, configured worktrees (idle/busy), and in-progress session ids.

```bash
auto-harness-agent status
```

### `validate`

Check config file, required env, git binary, worktree parent paths, and that labeled CLIs resolve on `PATH`.

```bash
auto-harness-agent validate
```

Exit non-zero on failure (useful before enabling systemd).

### `update` (or drain-restart)

Trigger **graceful auto-update**: enter draining (no new jobs), wait for current sessions to finish **without killing CLIs**, exit, then let the supervisor start the new version.

```bash
auto-harness-agent update
# equivalent operational intent: drain → wait → restart
```

See [agent.md — Auto-update](agent.md#auto-update-graceful-restart).

### `list-worktrees`

List worktrees from config and last-known local status.

```bash
auto-harness-agent list-worktrees
```

### `add-repo`

Interactive helper: append a repository entry to the config.

```bash
auto-harness-agent add-repo --path /home/harness/repos/my-app
# optional: --id repo-abc
```

`id` must match the control-plane repository id ([api.md](api.md) / UI).

### `add-worktree`

Append a worktree under a repo in the config.

```bash
auto-harness-agent add-worktree \
  --repo repo-abc \
  --path /home/harness/repos/my-app/.worktrees/wt-1 \
  --labels codex,claude
```

Options: `--id wt-1`, `--setup-script 'git fetch && …'`.

Restart (or reload) the agent after config edits so inventory re-registers.

---

## Common workflows

| Goal                 | Commands                                                    |
| -------------------- | ----------------------------------------------------------- |
| First boot on VPS    | `validate` → `start` (or systemd enable)                    |
| Add capacity         | `add-worktree` → restart agent → confirm in UI Agents       |
| Debug offline        | `status`, `validate`, `journalctl -u auto-harness-agent -f` |
| Point at local stack | `HARNESS_API_URL=ws://localhost:7420/ws start`              |

---

## Not in this CLI

| Action                  | Use instead                            |
| ----------------------- | -------------------------------------- |
| Create sessions         | `POST /sessions` ([api.md](api.md))    |
| Manage users / API keys | REST or Web UI                         |
| Live log tail           | Web UI / [websocket.md](websocket.md)  |
| Deploy AWS              | [setup.md](setup.md#aws-control-plane) |
