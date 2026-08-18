# QA runbook: cold account → full deployment → purge

A numbered, copy-pasteable script that takes an AWS account from nothing to a fully
exercised auto-harness environment — deployed, logged into, connected to a real host
daemon, driven through a real `claude -p` session over the REST API — and back to a
clean account. It exists because the individual pieces (`deploy-aws.md`,
`deploy-host-daemon.md`, `auth.md`, `api.md`) are each independently correct, but the
**seams** between them are where a first-time operator (human or agent) gets stuck, and
nothing in CI exercises those seams. This doc is what an agent should follow instead of
reading source — it is what a human would do from the site, and it is the thing that
should be kept in sync when the site changes.

Every step below was run against a real, disposable AWS environment (`qa`, `us-west-2`)
on 2026-08-18, purged clean afterward. Where a step surfaced a real bug or a doc gap, the
callout says so and links the fix — this doc is proof plus the traps, not a hypothetical
happy path.

Ops index: [deploy.md](deploy.md). AWS lifecycle detail: [deploy-aws.md](deploy-aws.md).
Host daemon: [deploy-host-daemon.md](deploy-host-daemon.md). Auth model: [auth.md](auth.md).

---

## Read this first

Three things end the run early if you don't know them going in.

### 1. A host needs two service accounts, not one

`POST /api/v1/sessions` rejects a bound service account (the kind a host daemon uses)
with a bare `404 {"error":{"code":"NOT_FOUND","message":"resource not found"}}` —
deliberately not `403`, with no mention of `boundHostId` anywhere in the response. If
session creation 404s and the repository/target IDs look right, this is almost always
why. See [auth.md#a-bound-key-cannot-create-sessions](auth.md#a-bound-key-cannot-create-sessions).

Mint **two** service accounts per host before Phase 2 below:

- a **bound** one (`boundHostId` set to the host's ID) for the daemon's `HARNESS_API_KEY`
- an **unbound** `operator` one for anything that creates sessions — this doc's Phase 4,
  a CI trigger, a webhook consumer

### 2. `claude -p` (or any subscription-authenticated CLI) needs an unsandboxed shell

The host daemon's child-process environment is a small explicit allowlist
(`HARNESS_CHILD_ENV_ALLOWLIST`) — it strips every `HARNESS_*` credential, and it strips
**CLI credential env vars too**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and similar are
silently dropped unless explicitly allowlisted. A subscription-authenticated CLI (reads
its own credential file under `$HOME`, no API key needed) works fine because `HOME`
survives the allowlist — but only if the daemon process itself has a real, logged-in
`$HOME/.claude` to read. If you are running this doc from inside an agent harness whose
own shell tool is sandboxed (no network, restricted filesystem), **`claude -p` will fail
there** with an opaque "not logged in" error even though the same command succeeds in an
unsandboxed shell on the same machine. Run the daemon itself — and the one-off `claude -p`
sanity check in Phase 3 — in a real, unsandboxed shell (a plain terminal, a `tmux`
session), not inside a sandboxed subagent tool call. See
[host-daemon.md#command-execution-model](host-daemon.md#command-execution-model).

### 3. Placeholders in this doc must be quoted when pasted

Every `<PLACEHOLDER>` below is angle-bracket-delimited to be visually obvious, but a
shell reads `<name` as a redirect from a file called `name`, not as "fill this in" — an
earlier version of the product's own UI made exactly this mistake in its connect-command
generator (fixed in #184; it now emits a quoted `'REPLACE_WITH_...'` placeholder
instead). Copy each command below into an editor first and replace the placeholder
**inside its quotes**, or export the real value to a shell variable and reference that —
never paste a command with a bare `<...>` still in it.

---

## Prerequisites

- Everything in [deploy-aws.md#prerequisites](deploy-aws.md#prerequisites): Node ≥22.18,
  pnpm, Docker running (needed by **every** lifecycle command, including `teardown` and
  `purge` — they re-synth the same Lambda image asset as `deploy`), AWS CLI credentials
  with the services listed there, `AWS_REGION` set.
- A repository the daemon can reach **on the same machine the daemon runs on** — the
  control-plane "attach repository" form takes an absolute host path that must already
  exist there. Attaching a path that doesn't exist does not fail validation; it fails
  much later, as a session that dies during git checkout. If you don't want to point this
  at a real working repo, clone one locally first (a local-path clone is faster and has
  no network dependency): `git clone /path/to/existing/repo /path/to/qa-repo`.
- A logged-in subscription CLI (`claude` or equivalent) on that same machine, verified
  with a bare `claude -p 'reply OK'` in a real shell **before** starting the daemon —
  see trap 2 above.
- `openssl` for generating secrets (used below; any equivalent generator works).

---

## Phase 1 — Choose and deploy a disposable environment

Never run this against `production`. Pick a throwaway `HARNESS_DEPLOY_ENVIRONMENT` (this
doc uses `qa`) and destroy-policy it from the start:

```bash
export AWS_REGION=us-west-2
export HARNESS_DEPLOY_ENVIRONMENT=qa
export HARNESS_DEPLOY_REMOVAL_POLICY=destroy
```

Create the three bootstrap SSM `SecureString`s (full detail and rationale:
[deploy-aws.md#secrets-and-config-never-commit](deploy-aws.md#secrets-and-config-never-commit)).
Save the printed admin password somewhere you can read it back — it's the only way to
sign in until a user account exists, step 2 below:

```bash
admin_password=$(openssl rand -base64 24)
admins_b64=$(echo '[{"username":"admin","password":"'"$admin_password"'"}]' | base64)
aws ssm put-parameter --type SecureString \
  --name "/auto-harness/$HARNESS_DEPLOY_ENVIRONMENT/harness-admins" --value "$admins_b64"
aws ssm put-parameter --type SecureString \
  --name "/auto-harness/$HARNESS_DEPLOY_ENVIRONMENT/harness-session-secret" \
  --value "$(openssl rand -base64 32)"
aws ssm put-parameter --type SecureString \
  --name "/auto-harness/$HARNESS_DEPLOY_ENVIRONMENT/harness-cursor-secret" \
  --value "$(openssl rand -base64 32)"
echo "Admin password: $admin_password"   # read this back now; don't rely on scrollback
```

Deploy:

```bash
pnpm install
pnpm --filter @auto-harness/cdk run deploy
```

Note the `run` — `pnpm --filter @auto-harness/cdk deploy` (no `run`) invokes pnpm's own
builtin `deploy` command, not the package script, and fails or does the wrong thing.

**Gate:** the command prints `RestApiUrl`, `WebSocketUrl`, and `WebUrl`, and both the
REST `/health` check and the web `/login` page load succeed before it exits. Record all
three URLs. **`WebUrl` (the CloudFront URL) is the one you give to a host daemon** as
`HARNESS_API_URL` — `RestApiUrl` and `WebSocketUrl` are deploy-time health-check/debug
values only, never a daemon config value. See
[deploy-aws.md#stack-parameters-and-outputs](deploy-aws.md#stack-parameters-and-outputs).

If the deploy fails partway (`ROLLBACK_COMPLETE`), `deploy` refuses to retry over it and
`update` can't repair a create-failed stack either — delete the failed stack(s) by hand
before retrying. Full detail:
[deploy-aws.md#deploy-a-new-environment](deploy-aws.md#deploy-a-new-environment).

---

## Phase 2 — Drive the site as a first-time operator

Everything in this phase is reachable from the control plane (`WebUrl`) alone — nothing
here requires opening a host's own `:7422` debug pane. If a step seems to require it,
that's a bug in the product, not a missing step in this doc.

1. **Log in** at `<WebUrl>/login` with `admin` / the password from Phase 1. (The very
   first request after a fresh deploy can render a blank page while CloudFront/Lambda
   cold-starts — a reload fixes it; it is not a failure.)
2. **Settings → User accounts** — create a real user account; bootstrap admin credentials
   are for initial setup, not day-to-day use.
3. **Settings → Service accounts** — create the two accounts from
   [Read this first, #1](#1-a-host-needs-two-service-accounts-not-one):
   - `<host-id>-daemon`, role operator, **bound** to the host ID you'll register next
   - `operator` (or similar), role operator, **not** bound

   Each key is shown exactly once — save both immediately.

4. **Hosts → Add host** — create a host slot (`<host-id>`). This only registers the slot;
   nothing is running yet.
5. On the host detail page, use **Connect** to get the daemon launch command. It embeds
   `HARNESS_API_URL` (must be `WebUrl`, confirmed above) and a placeholder for
   `HARNESS_API_KEY` — replace the placeholder with the **bound** key from step 3, quoted
   (see [Read this first, #3](#3-placeholders-in-this-doc-must-be-quoted-when-pasted)).
   Don't run it yet — the daemon needs a registered repository first, or the initial
   inventory sync has nothing to report.
6. **Attach a repository**: point it at the absolute path from Prerequisites. Then, still
   from the host detail page (**Repositories & Worktrees**), add at least one worktree —
   this is a control-plane action; the daemon creates the actual `git worktree` on disk
   itself the first time it starts (`git worktree add --detach`), keyed off
   `git worktree list --porcelain` for idempotency. **Do not pre-create the worktree
   directory yourself** — only the repository path needs to already exist as a valid git
   repo; a directory sitting at the worktree path before the daemon's first sync can
   collide with its own `git worktree add`.
7. **Create a Provider** (e.g. `claude`) with a default Command — argv `["claude", "-p"]`,
   append-prompt on. Creating a Provider auto-creates its default Command in the same
   step.
8. **Create a Provider Account** under that Provider, then **attach it to the host** from
   the host detail page's Provider accounts tab. This attachment step is what makes the
   account schedulable — an account that exists but isn't attached to any host is
   invisible to the scheduler, and there's no error or warning pointing at this if you
   skip it. See [web.md](web.md).

---

## Phase 3 — Start the host daemon

In a real, unsandboxed shell on the machine that has the repository and the
subscription-authenticated CLI (see [Read this first, #2](#2-claude--p-or-any-subscription-authenticated-cli-needs-an-unsandboxed-shell)):

```bash
claude -p 'Reply with exactly: OK'   # sanity check BEFORE starting the daemon
```

If that doesn't print `OK`, fix the CLI login before going further — every downstream
symptom (session stuck `queued`, then failing with an auth error) traces back to this.

```bash
HARNESS_HOST_ID='<host-id>' \
HARNESS_API_URL='<WebUrl>' \
HARNESS_API_KEY='<bound-daemon-key>' \
pnpm local:daemon start
```

**Gate:** the daemon logs `connected and registered`, and `GET /api/v1/hosts` (any key)
shows the host with `online: true` and the worktree ID(s) populated. An empty `items`
array means the host never registered — check `HARNESS_API_URL` is `WebUrl`, not
`RestApiUrl`.

---

## Phase 4 — Programmatic session (the acceptance test)

This is the pass/fail line for the whole run: a session created over the REST API with
the **unbound** operator key reaches `completed` with a real, streamed CLI reply.

1. Create a session with the **unbound** key:

   ```bash
   curl -sS -X POST "<WebUrl>/api/v1/sessions" \
     -H "Authorization: Bearer <unbound-operator-key>" \
     -H 'Content-Type: application/json' \
     -d '{
       "repositoryId": "<repository-id>",
       "prompt": "Reply with exactly the text: QA_SESSION_OK",
       "target": {"providerId": "<provider-id>"},
       "timeout": 180,
       "concurrencyId": "qa-runbook-smoke-1"
     }'
   ```

   Expect `201`, `"created": true`, `"status": "queued"`. Trying the **bound** daemon key
   here instead should get the `404` from
   [Read this first, #1](#1-a-host-needs-two-service-accounts-not-one) — worth
   confirming once, so you know what a misconfigured caller looks like.

2. Dispatch isn't synchronous — a scheduler sweep runs on its own cron (about once a
   minute). If you don't want to wait, `POST /api/v1/scheduler/assign` forces an
   immediate sweep, but it's **admin-only** — an operator key gets rejected. An operator
   key waits for the next automatic sweep; that wait is expected, not a hang.

3. Watch the session move `queued → running → completed`. On the daemon's own logs, or
   the session detail page's live log viewer, expect to see the resolved command spawn
   and the CLI's reply — with the example above, an `[stdout]` line containing
   `QA_SESSION_OK`.

4. **Concurrency dedup**: re-`POST` the exact same body (same `concurrencyId`) while the
   first is still `queued` or `running` → expect `200`, `"created": false`, same session
   ID. Re-`POST` the same `concurrencyId` **after** the first reaches a terminal status →
   expect a **new** session (`"created": true`) — the lock releases on completion, it
   doesn't stick forever.

5. Confirm the worktree returns to unassigned once the session completes (its
   `worktreeId` is `null` on the completed session record).

If every one of the above matches, the full stack — control plane, host daemon,
subscription-authenticated CLI, REST API, scheduler, WebSocket log streaming — is proven
end to end.

---

## Phase 5 — Tear down

Prefer purging a QA/disposable environment outright rather than a plain teardown — a
`retain`-policy teardown leaves the foundation stack (and its data) behind, which is the
correct behavior for `production` but pointless residue for a throwaway environment.

Stop the daemon first (clean `Ctrl-C`, not a kill signal, so it deregisters).

```bash
export HARNESS_DEPLOY_CONFIRM="$HARNESS_DEPLOY_ENVIRONMENT"
export HARNESS_DEPLOY_PURGE_CONFIRM="destroy-all-data-in-$HARNESS_DEPLOY_ENVIRONMENT"
export HARNESS_DEPLOY_PURGE_SSM=1
pnpm --filter @auto-harness/cdk run purge
```

Full mechanics, and exactly what `purge` does and does not remove (KMS 7-day pending
deletion window, log groups it never touches, shared CDK bootstrap assets it correctly
leaves alone): [deploy-aws.md#purge-irreversible](deploy-aws.md#purge-irreversible).

**Verify the negative, don't assume it.** Use unfiltered listings — a status-filtered
`list-stacks` call can silently hide a `DELETE_FAILED` stack:

```bash
aws cloudformation list-stacks \
  --query "StackSummaries[?starts_with(StackName, 'AutoHarness-$HARNESS_DEPLOY_ENVIRONMENT')]"
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/auto-harness/$HARNESS_DEPLOY_ENVIRONMENT/"
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/AutoHarness-$HARNESS_DEPLOY_ENVIRONMENT"
```

The first two should return nothing. The third **will** return four log groups — purge
does not delete Lambda's own auto-created log groups (they aren't CDK-managed resources).
Delete them by hand if you want the account fully clean:

```bash
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/AutoHarness-$HARNESS_DEPLOY_ENVIRONMENT" \
  --query 'logGroups[].logGroupName' --output text | \
  xargs -n1 aws logs delete-log-group --log-group-name
```

Do **not** delete the account's shared `cdk-hnb659fds-assets-*` staging bucket or
`cdk-hnb659fds-container-assets-*` ECR repo — those are shared across every environment
deployed with this CDK bootstrap, not specific to the one you just purged.

---

## Pass/fail checklist

- [ ] `deploy` prints all three URLs; REST `/health` and web `/login` both pass
- [ ] Login with the bootstrap admin succeeds
- [ ] Two service accounts created (one bound, one unbound)
- [ ] Host slot created, repository attached, worktree added — all from `WebUrl`, no
      `:7422` host-pane step required
- [ ] Provider, default Command, and Provider Account created; account attached to the
      host
- [ ] Daemon connects and registers (`online: true`, worktree populated)
- [ ] `POST /api/v1/sessions` with the **unbound** key returns `201`/`queued`
- [ ] Session reaches `completed` with the expected CLI output visible in logs
- [ ] Same-`concurrencyId` re-`POST` while active returns `created:false`; after terminal
      completion returns `created:true`
- [ ] `POST /api/v1/sessions` with the **bound** key gets the `404` from trap #1
- [ ] `purge` reports success; unfiltered `list-stacks` and `describe-parameters` both
      confirm nothing survives under the environment's name
- [ ] Leftover log groups (and only those — not shared CDK bootstrap assets) cleaned up
      by hand

---

## Known gaps

Things this run could not exercise or fully resolve — noted honestly rather than glossed
over:

- **Cost model still needs a heavier run.** The sessions in this runbook are single
  short CLI calls — enough to prove the pipeline, not enough to produce meaningful
  log-chunk-count, Lambda-duration, or archive-size numbers. [costs.md](costs.md) still
  carries placeholders that need a longer-running, more representative session to fill
  in for real.
- **`services/cdk/cdk.out/` collides with the vitest glob.** Running
  `pnpm --filter @auto-harness/cdk run synth` locally leaves a gitignored `cdk.out/`
  directory containing nested copies of the CDK package's own source (bundled Lambda
  assets). A subsequent local `vitest` run's default glob can pick up duplicate test
  files under `cdk.out/asset.*/services/...` and fail with a confusing
  `Cannot find package '@auto-harness/shared'` error that looks like a real regression.
  It isn't — CI always starts from a clean checkout, so this never affects CI, only a
  local dev loop that runs `synth` before `vitest`. Fix locally with
  `rm -rf services/cdk/cdk.out`.
- **First-deploy failure recovery is code-derived, not independently re-triggered.**
  [deploy-aws.md#deploy-a-new-environment](deploy-aws.md#deploy-a-new-environment)
  documents the `ROLLBACK_COMPLETE` recovery path from reading `stackExists`, not from a
  live reproduction — the deploy in this run succeeded on the first attempt.
- **Slack/integration flows are out of scope for this runbook.** It proves the core
  deploy → host → session loop; integration-specific setup isn't exercised here.
