# Production QA

A numbered script for QAing a real AWS Auto Harness environment: restore or
deploy the control plane, **sign in as admin** to set up the fleet (user
accounts, service accounts, hosts, repos, providers), persist a local host
daemon, **sign in as operator** to run real structured-output `grok -p`,
`claude -p`, and `codex exec --json` sessions, exercise a schedule, try to break the product, then
tear the environment down. Do not tell an operator to Add host.

This is the production-surface runbook. The laptop-only counterpart is
[qa-local.md](qa-local.md). Deploy mechanics: [deploy-aws.md](deploy-aws.md).
Host daemon install: [deploy-host-daemon.md](deploy-host-daemon.md). Auth
model: [auth.md](auth.md).

Keep this file in sync when the site changes. It is what a human (or an
agent acting as one) should follow instead of reading source.

---

## Read this first

Four things end the run early if you don't know them going in.

### 1. A host needs two service accounts, not one

`POST /api/v1/sessions` rejects a bound service account (the kind a host
daemon uses) with a bare `404 {"error":{"code":"NOT_FOUND","message":"resource
not found"}}` — deliberately not `403`, with no mention of `boundHostId` in
the response. If session creation 404s and the repository/target IDs look
right, this is almost always why. See
[auth.md#a-bound-key-cannot-create-sessions](auth.md#a-bound-key-cannot-create-sessions).

Mint **two** service accounts per host before connecting the daemon:

- a **bound** one (`boundHostId` set to the host's ID) for the daemon's
  `HARNESS_API_KEY`
- an **unbound** `author` (CI / automation) or `operator` (humans running the
  queue) key for anything that creates sessions — Phase 4's REST check, a CI
  trigger, a webhook consumer. Do not give CI `operator` unless it also needs
  schedules, cancel-any, or drain.

### 2. Subscription CLIs need an unsandboxed shell

The host daemon's child-process environment is a small explicit allowlist
(`HARNESS_CHILD_ENV_ALLOWLIST`). It strips every `HARNESS_*` credential and
rejects malformed, reserved, duplicate, or undefined allowlist names before work starts. Variables
required after native resume must come from the persisted daemon environment because resume skips
setup scripts. It strips CLI credential env vars too (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
and similar) unless those names are allowlisted. A subscription-authenticated
CLI (reads its own file under `$HOME`, no API key needed) works because
`HOME` survives — but only if the daemon process itself has a real, logged-in
`$HOME/.claude` / grok config to read.

If you are running this from inside an agent harness whose shell is
sandboxed (no network, restricted filesystem), `claude -p` and `grok -p`
fail with an opaque "not logged in" even though the same command succeeds in
a plain terminal on the same machine. Run the daemon — and the Phase 3 sanity
checks — in a real shell (`tmux`, iTerm), not a sandboxed tool call. See
[host-daemon.md#command-execution-model](host-daemon.md#command-execution-model).

### 3. Placeholders must be quoted when pasted

Every `<PLACEHOLDER>` below is angle-bracket-delimited to be obvious, but a
shell reads `<name` as a redirect from a file called `name`. The product's
own Connect command used to make this mistake (fixed in #184; it now emits
`'REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY'`). Copy each command into an editor
first and replace the placeholder **inside its quotes**, or export the real
value to a shell variable.

### 4. Control plane does everything; host pane is debug-only

Hosts connect to the control plane over WebSocket only. A user must be able
to attach repositories, add worktrees, manage provider accounts, and run
sessions **from the CloudFront `WebUrl`**. The host pane (`:7422`) exists
only for local debugging on that host. If a step seems to require opening
`:7422`, that is a product bug, not a missing step in this doc.

`HARNESS_API_URL` for the daemon is always `WebUrl` (CloudFront) — never a
raw `RestApiUrl` / `WebSocketUrl` `*.execute-api.*.amazonaws.com` value.

### 5. Docker ECR login can fail non-interactively on macOS

`update` / `deploy` builds the Web Lambda image and runs
`docker login` against the account's CDK ECR repo. On a Mac where the
default credential helper is the keychain, a non-interactive agent
session fails with `User interaction is not allowed. (-25308)` after
Foundation has already updated. Isolate Docker credentials before
retrying:

```bash
cfg=$(mktemp -d /tmp/qa-docker-cfg.XXXXXX)
bin=$(mktemp -d /tmp/qa-docker-bin.XXXXXX)
# a tiny docker-credential-* helper that stores in a file, not the keychain
# (see the 2026-08-18 production QA run)
export DOCKER_CONFIG="$cfg"
export PATH="$bin:$PATH"
```

Then retry `pnpm --filter @auto-harness/cdk run update`. Do not set
`HOME` to a fake directory to dodge the keychain — that also hides
`~/.aws` and the next AWS call fails with `Unable to locate credentials`.

---

## Prerequisites

- Everything in [deploy-aws.md#prerequisites](deploy-aws.md#prerequisites):
  Node ≥22.18, pnpm, Docker running (needed by **every** lifecycle command,
  including `teardown` and `purge` — they re-synth the same Lambda image),
  AWS CLI credentials, `AWS_REGION` set.
- `grok` and `claude` on `PATH`, already logged in on this machine. Verify
  in a real shell **before** starting the daemon (Phase 3). `codex` is
  optional; if it is installed, the catalog preset is `codex exec --json` — **not**
  `-p` (`-p` is `--profile`).
- A git repository the daemon can reach **on this machine**. The control-plane
  "attach repository" form takes an absolute host path that must already
  exist. Attaching a path that doesn't exist does not fail validation; it
  fails later, as a session that dies during git checkout. A local-path clone
  is enough: `git clone /path/to/existing/repo /path/to/qa-repo`.
- `openssl` (or any equivalent) if you still need to create bootstrap SSM
  parameters.
- During the UI phases: **do not read product docs** (`web.md`, `api.md`,
  this file beyond the current step). Navigate from labels. Write down every
  moment you had to guess — that is the UX finding.

---

## Phase 0 — Choose the environment

This runbook uses `production`. Confirm you mean to restore or destroy
**that** environment before continuing.

```bash
export AWS_REGION=us-west-2
export HARNESS_DEPLOY_ENVIRONMENT=production
```

**If any `AutoHarness-production-*` stack already exists** (including a
retained Foundation after a previous teardown): do **not** run `deploy`.
`deploy` refuses while any application stack exists — `stackExists`
(`services/cdk/src/deployment-support.ts`) only reports a stack absent when
CloudFormation's error text matches `does not exist`; a `describe-stacks`
call against a stack in any other status, `UPDATE_ROLLBACK_COMPLETE`
included, succeeds and counts as present. Use `update` in Phase 1 to
recreate missing Runtime/Web stacks on top of the Foundation.

**As of 2026-09-16 this no longer describes `production`.** It was purged and
redeployed that day and is now healthy: all three stacks `CREATE_COMPLETE`,
all 8 Sessions GSIs `ACTIVE`. See
[Account state (2026-09-16)](#account-state-2026-09-16--purged-and-redeployed-production-is-up).
Treat it as a normal existing environment — `update`, not `deploy`.

The paragraph that used to sit here described the 2026-09-08 outage state
(`Foundation` stranded in `UPDATE_ROLLBACK_COMPLETE`, Runtime and Web
`DELETE_COMPLETE`, Sessions holding 3 of 8 GSIs). That state is gone, but the
trap it warned about is not: see
[Traps found on 2026-09-15](#traps-found-on-2026-09-15) before running a plain
`update` that adds more than one GSI to any one table.

Either way, the three bootstrap SSM parameters still exist. `aws
ssm put-parameter` defaults to `--overwrite false`, so running the
cold-account block below against this account does not overwrite
production's real admin password or secrets — each `put-parameter` call
fails with `ParameterAlreadyExists` instead. The block has no `set -e`,
though, so it keeps going past those failures and still prints an
`admin_password` that was never stored anywhere. Only run it on a cold
account.

**If the account is cold** (no `AutoHarness-production-*` stacks at all):
create the three bootstrap SSM `SecureString`s first
([deploy-aws.md#secrets-and-config-never-commit](deploy-aws.md#secrets-and-config-never-commit)).
Save the printed admin password — it is the only way to sign in until a user
account exists:

```bash
set -e
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
echo "Admin password: $admin_password"
```

On an already-provisioned environment the three parameters already exist.
Retrieve the admin password only if you still have it; SSM `get-parameter
--with-decryption` can recover the JSON if you must.

For a disposable environment instead of `production`, set
`HARNESS_DEPLOY_ENVIRONMENT` to a throwaway name and
`HARNESS_DEPLOY_REMOVAL_POLICY=destroy` before first deploy.

---

## Phase 1 — Deploy or restore

```bash
pnpm install

# Check the Sessions table's GSI state before running update on a surviving
# Foundation. The plain `update` below has no staging guard (see the GSI
# trap in "Traps found on 2026-09-15") — if any index it prints is missing
# or not ACTIVE, do not run it; it will try to create them all in one
# CloudFormation update and fail.
aws dynamodb describe-table \
  --table-name "AutoHarness-$HARNESS_DEPLOY_ENVIRONMENT-Sessions" \
  --query 'Table.GlobalSecondaryIndexes[].{Name:IndexName,Status:IndexStatus}' \
  --output table

# Foundation present, Runtime/Web missing: restore Runtime + Web
pnpm --filter @auto-harness/cdk run update

# Cold account only:
# pnpm --filter @auto-harness/cdk run deploy
```

Note the `run` — `pnpm --filter @auto-harness/cdk deploy` (no `run`) invokes
pnpm's own builtin `deploy` command, not the package script.

**Gate:** the command prints `RestApiUrl`, `WebSocketUrl`, and `WebUrl`.
REST `/health` and the hosted `/login` page both succeed before it exits.
Record all three URLs. **`WebUrl` is the one you give to a host daemon** as
`HARNESS_API_URL`.

If a first `deploy` fails partway (`ROLLBACK_COMPLETE`), delete the failed
stack(s) by hand before retrying. `update` cannot repair a create-failed
stack. Full detail:
[deploy-aws.md#deploy-a-new-environment](deploy-aws.md#deploy-a-new-environment).
**Do not confuse this with an `UPDATE_ROLLBACK_COMPLETE` Foundation** — that
stack failed an _update_, not a create; it is stable, holds real data, and
must not be deleted. `update` can be retried against it once whatever caused
the failed update is fixed.

**This account cannot clear that gate today.** `AutoHarness-production-Sessions`
is missing `activeHostId-activeHostOrder` among other indexes (see
[Account state (2026-09-15)](#account-state-2026-09-15)), and
[deploy-aws.md's fresh-environment-cutover section](deploy-aws.md#fresh-environment-cutover-for-breaking-coordination-schemas)
is explicit that this repository provides no in-place backfill for that
index — adding it to an existing, populated Sessions table is not
sufficient. Restoring `production` needs that fresh-environment cutover (new
Foundation, paused admission, and a plan for the 356 existing session rows),
not a one-command `update`. Do not run the `update` above against this
account until that plan exists.

---

## Phase 2 — Fleet setup (admin)

Stay signed in as **admin** for this entire phase. User accounts, service
accounts, host slots, repositories, and providers are admin writes
([auth.md](auth.md#roles); `PUT /hosts/:id/inventory` is how **Add host**
lands). Do not log in as the operator yet — operators create sessions
(Phase 4), they do not Add host.

Everything in this phase is reachable from `WebUrl`. Do not open `:7422`.
Do not read `web.md`. Follow nav labels.

1. **Log in** at `<WebUrl>/login` with `admin` / the bootstrap password.
   The first request after a fresh deploy can render a blank page while
   CloudFront/Lambda cold-starts — a reload is not a failure.
2. **Settings → User accounts** — create a real user with role
   **operator** for Phase 4. Bootstrap admin is for fleet setup, not
   day-to-day session creation. **Stay on admin** for the rest of this
   phase. Logging out and back in as that operator is a UX finding if
   **Add host** / catalog writes then fail (they should).
3. **Settings → Service accounts** — create the two accounts from trap #1:
   - `<host-id>-daemon`, role **agent**, **bound** to the host ID you will
     register next
   - `author` (CI) or `operator` (humans), **not** bound

   Each key is shown exactly once — save both immediately.

4. **Hosts → Add host** — create a host slot (`<host-id>`). This only
   registers the slot; nothing is running yet. Open the host detail page.
5. **Connect this host** — copy the generated **foreground** command
   (`pnpm local:daemon start`). Confirm it embeds `HARNESS_API_URL` as
   `WebUrl` (the CloudFront origin, not `*.execute-api.*`) and
   `HARNESS_API_KEY='REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY'` (quoted). The
   panel also shows the persist path (`pnpm local:daemon install-service`)
   with the same quoted env vars. You need **two** keys: the bound daemon
   key for this command, and an unbound `author` (CI) or `operator` (humans)
   key for `POST /sessions` (a bound key 404s on session create on purpose).
   Don't run it yet — the daemon needs a registered repository first, or the
   initial inventory sync has nothing to report.
6. **Attach a repository** from the host detail page (**Repositories &
   Worktrees**): absolute path from Prerequisites. Then add at least one
   worktree. This is a control-plane action; the daemon creates the actual
   `git worktree` on disk the first time it starts (`git worktree add
--detach`). **Do not pre-create the worktree directory** — a directory
   sitting at that path can collide with `git worktree add`. Only the
   repository path must already exist as a valid git repo. Prefer a worktree
   path **outside** the repository (a sibling directory, e.g.
   `<repo>-worktrees/wt-1`) — the daemon disregards its own registered
   worktree directories when it checks whether the main checkout (used by
   **scheduled** sessions) is clean, but a sibling keeps daemon-managed
   directories out of the repo's own working tree entirely.
7. **Providers → Add provider** (the UI fills argv when the name matches a
   catalog preset — `claude`, `grok`, `codex`, `cursor` / `cursor-agent`):
   - name `claude`; default command name e.g. `claude-print`; argv one token
     per line: `claude`, `-p`, `--output-format`, `json`; append-prompt on
   - name `grok`; default command name e.g. `grok-print`; argv one token
     per line: `grok`, `--always-approve`, `--max-turns`, `3`, `--output-format`,
     `json`, `-p`
     (`-p` / `--single` takes the prompt as its option value).
     Append-prompt **on**, append-prompt separator **off** — a `--`
     before the prompt makes grok 1.0.5 exit 2 with `a value is required
for '--single <PROMPT>'`. Use `--output-format json`; `-p` still supplies the
     headless prompt.
   - name `codex`; default command name e.g. `codex-exec`; argv one token
     per line: `codex`, `exec`, `--json`. Append-prompt **on**, separator **on**
     (the catalog preset). **Do not use `-p`** — on Codex that is
     `--profile`, unrelated to the prompt.

   Creating a provider auto-creates its default command in the same submit.

8. On each provider's detail page, **create a Provider Account**, then
   **attach it to the host** from the host detail page's Provider accounts
   tab. An account that exists but isn't attached is invisible to the
   scheduler, and there is no error pointing at this if you skip it. Note
   whether the UI warns. See [web.md](web.md) after the run, not during it.

Write down every label, empty state, or next-step that you had to guess.

---

## Phase 3 — Start the host daemon (and the debug host pane)

In a real, unsandboxed shell on the machine that has the repository and
both CLIs:

```bash
claude -p --output-format json 'Reply with exactly: OK'
grok --always-approve --max-turns 3 --output-format json -p 'Reply with exactly: OK'
```

If either command does not return a successful JSON envelope containing `OK`, fix the CLI login before going
further — every downstream symptom (session stuck `queued`, then failing
with an auth error) traces back to this.

If `codex` is on `PATH`:

```bash
codex exec --json 'Reply with exactly: OK'
```

If `cursor-agent` is on `PATH`:

```bash
cursor-agent --print --force 'Reply with exactly: OK'
```

Run this with `HOME` set to the provider account's execution-profile home
([host-daemon.md#config-loader](host-daemon.md#config-loader)), not the
operator's own shell home — cursor-agent reads its login from
`$HOME/.cursor/cli-config.json`, and a login in the operator's home proves
nothing about the account the daemon will actually use. If this fails the same
way a live session does, the account (not the daemon) is the problem — see
[host-daemon.md#command-execution-model](host-daemon.md#command-execution-model)
for binding a Cursor account via `CURSOR_API_KEY` in that account's execution
profile instead of a logged-in `$HOME`.

Persist the daemon so it survives logout/reboot. Same command on linux
(systemd), macOS (LaunchAgent, current user), and Windows (logon scheduled
task, current user). Details:
[deploy-host-daemon.md](deploy-host-daemon.md).

```bash
export HARNESS_HOST_ID='<host-id>'
export HARNESS_API_URL='<WebUrl>'
export HARNESS_API_KEY='<bound-daemon-key>'
pnpm local:daemon install-service
```

Every platform refuses to write or restart with `local-1`, a local or malformed
URL, placeholders, or an empty `HARNESS_API_KEY`. This production path uses
`WebUrl` and the bound key. Existing persisted environments are validated before
service-manager mutation.

On macOS, verify the installed production identity by pointing `status` at the persisted
LaunchAgent environment. A plain status command falls back to the local-development identity and
can misleadingly report a running LaunchAgent alongside an unreachable `local-1` control plane:

```bash
env -u HARNESS_HOST_ID -u HARNESS_API_URL -u HARNESS_API_HTTP -u HARNESS_API_KEY \
  HARNESS_ENV_FILE="$HOME/Library/Application Support/auto-harness/host-daemon.env" \
  pnpm local:daemon status
```

Clearing the explicit identity variables ensures stale shell exports cannot override values from the
persisted file. **Gate:** status is `ok`, reports the expected production host ID, and shows `reachable: true`,
`online: true`, `draining: false`, and `gitReady: true`. Do not print the environment file; it
contains the bound daemon key.

Foreground `pnpm local:daemon start` with the same env is fine for a
one-shot unsandboxed sanity check; **persist is the path this runbook
expects to leave running.**

**Gate:** the daemon logs `connected and registered`, and `GET /api/v1/hosts`
(any key) shows the host with `online: true` and the worktree ID(s)
populated. An empty `items` array means the host never registered — check
`HARNESS_API_URL` is `WebUrl`, not `RestApiUrl`.

Optional debug pane (not required for any operator step):

```bash
HARNESS_HOST_ID='<host-id>' \
HARNESS_API_URL='<WebUrl>' \
HARNESS_API_HTTP='<WebUrl>' \
pnpm local:host-pane
# → http://127.0.0.1:7422
```

The host pane has no login page. Production API auth is a signed cookie on
the CloudFront domain; `:7422` will not have that cookie. Record exactly
what you see (inventory, 401, empty, error). If `HARNESS_AUTH_MODE` is not
`required` locally, the pane may proxy unauthenticated to a required
production API and fail closed. **That seam is in scope.** You must still
be able to finish the rest of this runbook from `WebUrl` alone.

---

## Phase 4 — Sessions as operator (structured `grok`, `claude`, and `codex`)

**Log out of admin. Log in as the operator** created in Phase 2. Create
sessions from **New session** on the control plane (primary). Do not Add
host, edit inventory, or change the catalog — those stay admin. Use the
REST API once with the unbound key as the programmatic acceptance test,
and once with the bound key to confirm trap #1.

Dispatch is not completion-synchronous: `POST /sessions` returns the queued
session immediately while assignment is attempted as a best-effort side effect.
If no host has capacity yet, a one-minute repair sweep retries. Waiting while
queued is expected, not a hang. `POST /api/v1/scheduler/assign` forces a sweep
but is **admin-only**.

### Prompt matrix

Run each row against **both** `claude` and `grok` unless noted. If you
created the `codex` provider in Phase 2, also run row 1 as `codex exec --json`
(not `-p`).

| #   | Prompt                                                                                            | Why                                    |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | `Reply with exactly: QA_SESSION_OK`                                                               | Happy path; assert that text in stdout |
| 2   | `List the files in the current directory in one short sentence. Do not edit or create any files.` | Read-only cwd                          |
| 3   | empty / whitespace-only                                                                           | Validation vs queued-then-failed       |
| 4   | a multi-kilobyte prompt (repeat a paragraph)                                                      | List truncation vs full text on detail |
| 5   | `"; rm -rf /` then `Reply with exactly: QA_NO_SHELL`                                              | Catalog argv is not a shell string     |
| 6   | same body + `concurrencyId` while #1 is active, then again after it is terminal                   | `created: false` then a new session    |

### REST acceptance (unbound key)

```bash
curl -sS -X POST "<WebUrl>/api/v1/sessions" \
  -H "Authorization: Bearer <unbound-operator-key>" \
  -H 'Content-Type: application/json' \
  -d '{
    "repositoryId": "<repository-id>",
    "prompt": "Reply with exactly the text: QA_SESSION_OK",
    "target": {"providerId": "<claude-or-grok-provider-id>"},
    "timeout": 180,
    "concurrencyId": "qa-production-smoke-1"
  }'
```

Expect `201`, `"created": true`, `"status": "queued"`. The bound daemon key
on the same body must 404 (trap #1). Re-`POST` the same `concurrencyId`
while queued/running → `200`, `"created": false`, same id. Re-`POST` after
terminal → new session.

### Watch

On the session detail page's live log viewer (or the daemon's own logs):
`queued → running → completed`, spawn line shows the resolved argv (not a
shell string), stdout contains the expected reply. Confirm the worktree
returns to unassigned (`worktreeId` is `null` on the completed record).

---

## Phase 5 — Schedule

Still as the operator, from **Schedules**, still without reading product
docs:

1. Create a schedule against the same repository and a provider target.
   Fill cron with something a human can read (`0 * * * *` is fine). Set a
   concurrency id.
2. Open the schedule detail page. Use **Run now** — do not wait for cron.
   Expect a session with source `schedule`, a history row, and worktree
   labeled **Main checkout**.
3. Disable the schedule. Confirm it no longer offers automatic runs.
   **Run now** while disabled: record whether it still works (and whether
   that is obvious).
4. **Run now** twice with the same concurrency id while the first session
   is still active. Expect the second to attach to the first, not start a
   parallel run.

Note every label a new operator would misread (`cron`, `Queue TTL`,
target vs command, "Main checkout").

---

## Phase 6 — Exploratory / break it

All from the UI where possible. Record the actual message, not what you
expected.

- Attach a repository path that does **not** exist on the host. Does the
  form warn, or does a later session die at checkout?
- Create a session with the host drained or the daemon stopped.
- Delete a Command that a schedule still references.
- Invalid cron, duplicate host ids, browser back during submit,
  double-click submit.
- Kill the daemon mid-session. Session detail: stale warning, Force-cancel.
- Settings empty/error states (user accounts, service accounts).
- Narrow viewport: does the grouped nav hide items without a hint?
- Keyboard-only: login, new session, schedule create, host connect.
- Try to do attach/edit **only** from the host pane. The product must not
  require it.

Then walk every surface that shares the state you just wrote — Dashboard
counts, Sessions list, host detail, Worktrees, schedule history — and look
for a number or badge that no longer matches.

---

## Phase 7 — UX review

Score as a first-time human. Do not open terminology.md until after.

- Can you tell Host / Session / Provider / Command / Worktree apart from
  the chrome alone?
- Empty states: do they name the next click?
- Errors: bound-key 404, missing provider-account attach, bad repo path —
  actionable, or silent?
- Connect command: quoted placeholder, `WebUrl`, not raw execute-api.
- Is the host pane obviously debug-only?
- Would you trust an on-call engineer who had never read these docs to
  recover a stuck session?

---

## Phase 8 — Tear down

Prefer purging a QA environment outright. For `production` this destroys
the retained Foundation tables, archive bucket, and (after AWS's seven-day
window) the integration KMS key. Re-confirm the environment name before
continuing.

Stop the daemon first so it deregisters. If you persisted it in Phase 3:

```bash
pnpm local:daemon uninstall-service
```

Otherwise clean Ctrl-C. Stop the host pane if you started one.

Before purging, capture the physical names of the retained log groups.
Runtime and web Lambdas provision their own `AWS::Logs::LogGroup` stack
resources with `RemovalPolicy.RETAIN` (see
[deploy-aws.md#purge-irreversible](deploy-aws.md#purge-irreversible)); their
physical names are CDK-generated, not the `/aws/lambda/<function>` convention,
so they must be read from the stacks while those stacks still exist:

```bash
for stack in Runtime Web; do
  aws cloudformation describe-stack-resources \
    --stack-name "AutoHarness-$HARNESS_DEPLOY_ENVIRONMENT-$stack" \
    --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" \
    --output text
done | tee "/tmp/${HARNESS_DEPLOY_ENVIRONMENT}-retained-log-groups.txt"
```

If this environment was ever deployed before the `logGroup:` migration
(#354), it may _also_ carry older `/aws/lambda/AutoHarness-<environment>*`
groups from the previous `logRetention`-based mechanism — those were never
CDK-managed, so they won't appear in the capture above. Check for them too,
and fold any hits into the same file:

```bash
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/AutoHarness-$HARNESS_DEPLOY_ENVIRONMENT" \
  --query 'logGroups[].logGroupName' --output text | tr '\t' '\n' \
  | tee -a "/tmp/${HARNESS_DEPLOY_ENVIRONMENT}-retained-log-groups.txt"
```

```bash
export HARNESS_DEPLOY_CONFIRM="$HARNESS_DEPLOY_ENVIRONMENT"
export HARNESS_DEPLOY_PURGE_CONFIRM="destroy-all-data-in-$HARNESS_DEPLOY_ENVIRONMENT"
export HARNESS_DEPLOY_PURGE_SSM=1
pnpm --filter @auto-harness/cdk run purge
```

Mechanics, and what purge does not remove:
[deploy-aws.md#purge-irreversible](deploy-aws.md#purge-irreversible).

**Verify the negative.** Unfiltered listings — a status-filtered
`list-stacks` call can hide `DELETE_FAILED`:

```bash
aws cloudformation list-stacks \
  --query "StackSummaries[?starts_with(StackName, 'AutoHarness-$HARNESS_DEPLOY_ENVIRONMENT')]"
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/auto-harness/$HARNESS_DEPLOY_ENVIRONMENT/"
```

That should return no bootstrap or public-base-url parameters. If OAuth app
credentials were configured, the optional `HARNESS_SLACK_APP_SSM_PARAM` remains
by design because it may be shared across environments. The log groups captured
above **will** still exist — purge never deletes them, whether they're
RETAIN-policy CDK stack resources or pre-migration groups CDK never managed at
all. Delete them by hand if you want the account fully clean:

```bash
xargs -n1 aws logs delete-log-group --log-group-name \
  < "/tmp/${HARNESS_DEPLOY_ENVIRONMENT}-retained-log-groups.txt"
```

Do **not** delete `cdk-hnb659fds-assets-*` or
`cdk-hnb659fds-container-assets-*` — those are shared CDK bootstrap
assets, not this environment.

---

## Pass/fail checklist

- [ ] `update` or `deploy` prints all three URLs; REST `/health` and web
      `/login` both pass
- [ ] Login with the bootstrap admin succeeds
- [ ] Phase 2 stayed **admin**: a real operator user account exists; two
      service accounts created (one bound, one unbound); host slot,
      repository, worktree, and providers set up from `WebUrl` — no
      `:7422` step, no operator Add host
- [ ] Providers `grok`, `claude`, and `codex` (`codex exec --json`, not `-p`),
      default Commands, Provider Accounts created; accounts attached to
      the host (`codex` may be skipped if the binary is missing)
- [ ] Daemon persisted with `pnpm local:daemon install-service` and
      registers (`online: true`, worktree populated)
- [ ] Host pane either works as debug or fails in a documented, obvious
      way; no operator step required it
- [ ] Logged in as the operator (not admin) before creating sessions
- [ ] `POST /api/v1/sessions` with the unbound key returns `201`/`queued`
- [ ] At least one `claude -p` and one `grok -p` session reach `completed`
      with the expected CLI output visible in logs
- [ ] If Codex was configured: at least one `codex exec --json` session reaches
      `completed` (not `codex -p`)
- [ ] Prompt matrix rows recorded (pass, fail, or skipped with reason)
- [ ] Same-`concurrencyId` re-`POST` while active returns `created:false`;
      after terminal completion returns `created:true`
- [ ] Bound key `POST /sessions` gets the 404 from trap #1
- [ ] Schedule created from the UI; **Run now** produces a `schedule`
      session and a history row
- [ ] Exploratory cases recorded; Dashboard / Sessions / host / worktrees
      stay consistent
- [ ] UX notes captured without reading product docs first
- [ ] `purge` reports success; unfiltered `list-stacks` and
      `describe-parameters` confirm nothing survives under the
      environment's name
- [ ] Leftover log groups (and only those) cleaned up by hand

---

## After the run

Update this file when a step is wrong. Do not leave a known trap only in a
chat transcript.

### Observed results (2026-08-18)

_Superseded — see [Account state (2026-09-15)](#account-state-2026-09-15)
below. This run's purge really did succeed as described; the account has
since been redeployed, updated, and gone down again._

- Local: `claude -p` session `sess-87b4bfdd` completed, stdout `QA_SESSION_OK`.
  Grok with the old `-p` + `--` separator failed (`--single` required a
  value). Grok with `-p` and append-prompt separator **off**
  (`sess-692d244c`) completed, stdout `QA_GROK_OK`. Echo sessions
  completed. `POST /sessions` with `commandId: does-not-exist` returned 400. Schedule **Run now** (`POST …/schedules/:id/trigger`) created
  `sess-bf4c46c9`, `source=schedule`, prompt `scheduled:qa-hourly`,
  worktree labeled main checkout, exit 0.
- Production (restored via `update`, `<WebUrl>`): laptop daemon registered over
  `wss://…/ws`. Operator-key `claude -p` `sess-f1ae369b` completed
  (`QA_SESSION_OK`). Operator-key `grok -p` `sess-4108eb2c` completed
  (`QA_GROK_OK`). Same `concurrencyId` re-POST returned `created:false`.
  Bound-key `POST /sessions` returned 404. Operator
  `POST /scheduler/assign` returned 403. Schedule trigger created
  `sess-438641ee` (`source=schedule`); Claude treated
  `scheduled:qa-prod-hourly` as a real task and wrote a confused essay.
- Teardown: `purge` with `HARNESS_DEPLOY_PURGE_SSM=1` destroyed Web,
  Runtime, and Foundation. SSM `/auto-harness/production/*` gone. Seven
  leftover `/aws/lambda/AutoHarness-production*` log groups deleted by
  hand. KMS key is in AWS’s 7-day pending-deletion window.

### Account state (2026-09-15)

_Superseded — see
[Account state (2026-09-16)](#account-state-2026-09-16--purged-and-redeployed-production-is-up)
below. This section records the outage state accurately; production has since
been purged and redeployed, and none of the "missing GSI" rows below still
hold._

Verified against the live account (`010438466032`, `us-west-2`) — this
supersedes the teardown line above, which was accurate only for that day.

- `AutoHarness-production-Foundation`: **exists**, `UPDATE_ROLLBACK_COMPLETE`.
  Created 2026-08-20 (two days after the purge above — the account was
  redeployed shortly after that run), last updated 2026-09-08 (that update
  **failed and rolled back**; see the GSI trap in
  [Traps found on 2026-09-15](#traps-found-on-2026-09-15)).
- `AutoHarness-production-Runtime` and `AutoHarness-production-Web`: both
  `DELETE_COMPLETE`. **Production has been fully down since 2026-09-08**, but
  the Foundation and its data survive.
- 24 DynamoDB tables live, including `AutoHarness-production-Sessions` with
  **356 items**.
- S3 archive bucket
  `autoharness-production-fo-sessionarchivebucket116e-oikdcsxwq0wq` still
  exists.
- SSM `/auto-harness/production/harness-admins`, `harness-cursor-secret`,
  `harness-session-secret`, and `public-base-url` all still exist —
  recreated after the purge above, which is why the "SSM ... gone" line in
  that section is no longer true; it was accurate only until the next
  deploy recreated them.
- `CDKToolkit` is `CREATE_COMPLETE` — CDK stays bootstrapped in this
  account/region regardless of application-stack state.

`AutoHarness-production-Sessions` GSI state, against the 8 defined in
`services/cdk/src/tables.ts`:

| GSI                                   | Status  |
| ------------------------------------- | ------- |
| `repositoryId-createdAt`              | ACTIVE  |
| `statusShard-queueOrder`              | ACTIVE  |
| `statusShard-createdAt`               | ACTIVE  |
| `statusShard-createdOrder`            | missing |
| `statusShard-priorityOrder`           | missing |
| `statusShard-repositoryPriorityOrder` | missing |
| `parentSessionId-createdOrder`        | missing |
| `activeHostId-activeHostOrder`        | missing |

See [Traps found on 2026-09-15](#traps-found-on-2026-09-15) for why this
happened and why it is not a one-command fix.

### Account state (2026-09-16) — purged and redeployed, production is up

Supersedes the 2026-09-15 section above. Production was purged and redeployed
from merged `main` at `97b72997`, ending the outage that began 2026-09-08.

The purge only became possible that morning: it had failed on 2026-09-16 on
the _same_ multi-GSI limit that caused the outage, because its retarget step
synthesized all 8 Sessions GSIs against a table holding 3. Fixed in #757, which
restricts the retarget to each table's live index set.

Sequence that worked, run from a clean `main` checkout:

```bash
export AWS_REGION=us-west-2 AWS_PAGER=""
export HARNESS_DEPLOY_ENVIRONMENT=production
export HARNESS_DEPLOY_CONFIRM=production
export HARNESS_DEPLOY_PURGE_CONFIRM=destroy-all-data-in-production
unset HARNESS_DEPLOY_PURGE_SSM
pnpm --filter @auto-harness/cdk run purge

unset HARNESS_DEPLOY_CONFIRM HARNESS_DEPLOY_PURGE_CONFIRM
export HARNESS_DEPLOY_REMOVAL_POLICY=retain
pnpm --filter @auto-harness/cdk run deploy   # note `run`: bare `pnpm deploy` is a pnpm builtin
```

**Check the stored template before purging, not just the live tables.** The
#757 fix restricts the retarget toward the _live_ GSI set, but CloudFormation
diffs against the _stored_ template. Had the stored template listed more
indexes than the table really had, the retarget would have computed several GSI
deletions in one update and failed the same way in the opposite direction. They
agreed here, verified beforehand with:

```bash
aws cloudformation get-template --stack-name AutoHarness-production-Foundation \
  --template-stage Original --output json   # then read Resources.*.Properties.GlobalSecondaryIndexes
```

Result, verified against the live account:

| Check                      | Result                                                               |
| -------------------------- | -------------------------------------------------------------------- |
| Foundation / Runtime / Web | all `CREATE_COMPLETE`                                                |
| Sessions GSIs              | **8 / 8 ACTIVE**, incl. `activeHostId-activeHostOrder`               |
| Tables not `ACTIVE`        | 0                                                                    |
| `public-base-url`          | the CloudFront domain, not `localhost:7421`                          |
| `/health`, `/login`        | `200`; `/health` → `{"ok":true}`                                     |
| Page-content QA            | **12 / 12** pages render real data, 0 digest leaks                   |
| `claude -p` session        | `queued → running → completed`, `exitCode 0`, agent summary returned |
| Bound-key `POST /sessions` | `404` (trap #1 still holds)                                          |

Deploying fresh also resolved the GSI backlog outright: all 8 Sessions indexes
were created in the initial `CREATE`, which has no one-GSI-per-update limit.

#### Trap: purge orphans tables that have left the catalog

`purge` reported complete success while leaving
`AutoHarness-production-SessionLogs` live — 954 items, deletion protection
still enabled.

`SessionLogs` was retired from `services/cdk/src/tables.ts` when log bodies
moved to S3, but the stack created 2026-08-19 still carried the resource. The
retarget synthesizes the _current_ catalog, so the resource was dropped from
the stack while its `DeletionPolicy` was still `Retain`:

```
AutoHarness-production-Foundation | 33/35 | DELETE_SKIPPED | AWS::DynamoDB::Table | SessionLogsABAF303F
```

The later `destroy` never saw it, because it was no longer stack-managed, and
purge exited 0. This is the mirror image of #757: that fix handled a table whose
indexes fell _behind_ the catalog; this is a table that fell _out_ of it.

After any purge of a long-lived environment, check for survivors:

```bash
aws dynamodb list-tables --output text --query 'TableNames[]' \
  | tr '\t' '\n' | grep "^AutoHarness-${HARNESS_DEPLOY_ENVIRONMENT}-"
```

Do not delete survivors by prefix match alone — table prefixes are
`AutoHarness-${environment}`, so an environment named `prod` prefix-matches
tables belonging to one named `prod-extra`. The stack's stored template is the
safe source of truth for what a given stack actually owned — capture it
(as above) _before_ running `purge`. `purge` also destroys the Foundation
stack itself, and `get-template` on an already-deleted stack needs its
unique stack ID, not just its name, so there is no fetching it afterward.

### Findings

#### Blockers

1. Documented grok argv (`-p` plus default `--` separator, often with
   `--output-format plain`) fails on grok 1.0.5. Working: argv
   `["grok","--always-approve","--max-turns","3","-p"]`, append-prompt
   on, separator off.
2. `update`/`deploy` on a non-interactive Mac can fail Docker ECR login
   (`User interaction is not allowed. (-25308)`). Foundation may update
   while Web never deploys.
3. Session `url` is `http://localhost:7421/sessions/…` after a restore
   even though `/auto-harness/<env>/public-base-url` is the CloudFront
   URL. Warm Lambdas keep the localhost fallback.
4. CloudFront login can sit on **Signing in…** after `POST /auth/login` 200. A full navigation then works with the cookie.

#### UX confusion

5. Daemon log: `add local repos in the host pane UI` — contradicts
   invariant 10 (control plane does everything).
6. Dashboard **Get started** still says “Connect a host” when Hosts
   online is already `1/1`.
7. **Logout** is visible with local auth disabled. Settings says
   “Authentication disabled” and hides service accounts.
8. Host detail defaults to **Overview**; attach is on **Repositories &
   Worktrees**.
9. A retain-policy teardown leaves old hosts/service accounts
   (`jongs-mac-studio` this run) with no leftover-data explanation.
10. Default schedule prompt `scheduled:<name>` is treated as a real
    coding task by `claude -p`.
11. `PUT` inventory accepts a garbage `providerAccountId`;
    `GET /session-targets` then shows `available: false` with no error.
12. Host pane against a remote `WebUrl` has no login and embeds API
    401s.
13. Grouped nav overflows at mobile width; Catalog/Fleet/Settings can
    be missed.

#### Doc drift

14. Pre-deploy grok example used `--output-format plain` and the `--`
    separator. Corrected in this file, [qa-local.md](qa-local.md), and
    [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).
15. Schedule trigger is `POST /api/v1/schedules/:id/trigger`, not
    `/run`.
16. `deploy` refuses while any `AutoHarness-production-*` stack exists
    (including a retained Foundation). Restore is `update`.

#### Follow-up PRs (one concern each)

| Priority | Follow-up                                                                                              | PR   |
| -------- | ------------------------------------------------------------------------------------------------------ | ---- |
| P0       | Grok catalog defaults: separator off; drop stale `--output-format plain`                               | #210 |
| P0       | Recycle REST Lambdas after writing `public-base-url`, or read the param on every request               | #211 |
| P1       | Stop telling operators to use the host pane (daemon log + copy)                                        | #212 |
| P1       | Dashboard empty state: skip “Connect a host” when a host is already online                             | #213 |
| P1       | Let a schedule store an explicit prompt; do not default to `scheduled:<name>` for a real CLI           | #221 |
| P1       | Unstick login after a successful `POST /auth/login`                                                    | #214 |
| P2       | Reject unknown `providerAccountId` on inventory write; warn when an account is attached to no host     | #220 |
| P2       | Hide Logout / service-account chrome when auth is disabled; label leftover hosts after retain teardown | #219 |
| P2       | Host pane: debug-only chrome + a readable 401                                                          | #218 |
| P2       | Document the Mac Docker keychain deploy trap in [deploy-aws.md](deploy-aws.md)                         | #215 |
| P3       | CloudWatch log retention so purge is actually clean                                                    | #216 |
| P3       | Investigate local `react-dom/client` typecheck failure (`pnpm check`)                                  | #217 |

---

## Traps found on 2026-08-18 (this run)

- **`update` on a Mac agent session:** Docker ECR login fails with
  `User interaction is not allowed. (-25308)` unless Docker credentials
  are isolated from the keychain (trap #5).
- **Session `url` is `http://localhost:7421/sessions/…` on a fresh
  restore.** The deploy script writes
  `/auto-harness/<env>/public-base-url` _after_ Runtime health checks.
  Lambdas that already cold-started keep the localhost fallback until
  they recycle. Recycle the REST Lambda (touch any env var) before
  sending humans a session URL.
- **Login can sit on "Signing in…"** after a 200 from
  `POST /api/v1/auth/login`. A full navigation to `/hosts` then works
  with the cookie. Do not treat a stuck spinner as a failed login until
  you try another nav click.
- **Retained Foundation keeps old hosts and service accounts.** After
  a previous `teardown` (not `purge`), Hosts lists the leftover offline
  slot (this run: `jongs-mac-studio`) with no "this is leftover data"
  explanation.
- **Default scheduled prompt is `scheduled:<name>`.** A real `claude -p`
  treated that as a task ("what is qa-prod-hourly?") and wrote a
  confused essay. Set an explicit prompt on the schedule if you care
  what the CLI does.
- **Grok argv** — see Phase 2. `-p`/`--single` consumes the prompt;
  leave the append-prompt separator off.
- **Host pane against `WebUrl`:** `next dev` on `:7424` with
  `HARNESS_API_HTTP=<WebUrl>` loads a page that embeds API 401s. There
  is no login form. Operators do not need it.

## Traps found on 2026-09-15

- **DynamoDB allows only one GSI create or delete per table update; a
  Sessions table that has fallen behind by more than one index fails the
  whole Foundation update.** Exact error, from CloudFormation stack events
  on the 2026-09-08 update:

  ```
  UPDATE_FAILED  Sessions8896A56D
  Resource handler returned message: "Cannot perform more than one GSI creation or deletion in a single update"
  (HandlerErrorCode: InvalidRequest)
  ```

  Every other table in the stack then reports `UPDATE_FAILED ... "Resource
update cancelled"`, and the whole Foundation stack rolls back to
  `UPDATE_ROLLBACK_COMPLETE` — the tables and their data survive, but the
  update accomplishes nothing. This is what took `production` down (see
  [Account state (2026-09-15)](#account-state-2026-09-15)).

  Why: `services/cdk/src/tables.ts` currently defines 8 GSIs on Sessions,
  and an existing, populated environment only has the ones it was deployed
  or updated with at the time. The plain `pnpm --filter @auto-harness/cdk
run update` (Phase 1) has no guard for this — `update()` in
  `services/cdk/src/deployment.ts` only checks that the Foundation stack
  exists, and `applyDeployment` always synthesizes the full current
  template (`cdkContext`'s stage defaults in
  `services/cdk/src/deployment-support.ts` are `"both"`/`"status"` — every
  index). If more than one GSI the live table doesn't have yet shows up in
  that template, this is the result.

  The staged-rollout remedy that exists in the repo only covers three of
  the eight indexes. `pnpm deploy:aws` (`scripts/deploy-aws.sh`) checks
  `statusShard-priorityOrder`, `statusShard-repositoryPriorityOrder`, and
  `statusShard-createdOrder` specifically, and adds them one at a time —
  `priority-index-status`, then `priority-index-both`, then
  `created-order-index` (`services/cdk/package.json`) — waiting up to 600s
  (`wait_for_session_priority_index`: 300 polls × 2s) for each to report
  `ACTIVE` before the next is added. `parentSessionId-createdOrder` and
  `activeHostId-activeHostOrder` are not gated by either stage flag in
  `foundation-stack.ts`'s `stagedTables()` (it only ever filters
  `statusShard-repositoryPriorityOrder` and `statusShard-createdOrder`), so
  both are present in every stage's template regardless. `deploy-aws.sh`
  hard-fails up front, before touching anything, if an existing Sessions
  table lacks an `ACTIVE` `activeHostId-activeHostOrder` index — precisely
  because that one has no staged remedy: per
  [deploy-aws.md's fresh-environment-cutover section](deploy-aws.md#fresh-environment-cutover-for-breaking-coordination-schemas),
  it is a fresh-environment cutover, and this repository provides no
  in-place backfill for it.

- **`deploy` refuses while any `AutoHarness-production-*` stack exists,
  `UPDATE_ROLLBACK_COMPLETE` included.** A cold-account reading of Phase 0 —
  create bootstrap SSM parameters, then `deploy` — is wrong on this account
  today: the Foundation survives, and the three bootstrap SSM parameters
  already hold production's real values. See
  [Account state (2026-09-15)](#account-state-2026-09-15).

## Why the 2026-09-16 bugs reached production

Asked after the redeploy: how did these get past CI since the last release, and
is the answer more tests, Playwright, or more static-analysis rules?

**The post-deploy verification was two status codes.** `smokeDeployment` in
`services/cdk/src/deployment-support.ts` did exactly this:

```
GET {WebUrl}/health   → assert body.ok === true
GET {WebUrl}/login    → assert response.ok
```

Every bug found that day passes it:

| Bug | What the smoke check saw |
| --- | --- |
| SSR fetches omit the ingress token | 12 pages return **200 rendering nothing**; `/login` is 200 |
| `dynamodb:Scan` ungranted → `/hosts` 500 | never probed |
| Login redirect loop | the loop is _post_-login; smoke never authenticates |
| `NEXT_` digest leaked into the HTML | 200, with the digest as visible text |
| Resume 409 (#762), unrouted write 403 (#763) | never probed |

It was structurally incapable of failing for any of them: it asserted status
codes, and every one of these bugs returns a good status code. Both probes are
also the weakest two requests available — `/health` is a static literal
(`local-app.ts`) that touches no storage, and `/login` is the one page that
makes no API call at all.

### Two of them were not deployment-parity bugs

Worth separating, because the fix differs:

- **#762 (resume → 409) had a test that asserted the bug.** A case named
  `"has nothing to resolve without a live lease owner"` pinned `{ ok: false }`.
  Coverage was green. No tool catches a spec written wrong — more tests of the
  same kind would have produced more confidently-wrong assertions. Drain and
  resume are inverse operators whose tests were written independently; the
  defense is a **paired operator table**, not more coverage.
- **#763 (unrouted write → 403) was fully reachable locally.** Any `POST` to
  `/api/v1/frobnicate` against `local-app.ts` reproduces it. That was a missing
  **negative** test, not a parity gap.

### Playwright was not the gap

`pnpm test:e2e` builds Next locally and runs against a local API. CloudFront,
the API Gateway REQUEST authorizer, and IAM — the three things that actually
broke — do not exist in that harness, so the Playwright suite could not have
caught any of the deployment bugs. It remains the right tool for UI regressions
and was correctly added in #746; it is not a substitute for probing a deployed
environment.

### What actually closes the gaps

1. **Assert content, not status, in the deployed smoke probe.** No new
   credentials; catches the SSR-empty and digest-leak classes on public surface.
2. **A checked-in `(table, operation)` manifest** cross-checking `ScanCommand`
   call sites against CDK IAM grants. Makes the #748 class impossible and
   enforces [invariant 13](plan.md#5-invariants). A blanket `Scan` ban would be
   wrong — there are legitimate documented catalogs — but each one should be
   deliberate.
3. **A `docs/openapi.yaml` ↔ `auth-policy.ts` consistency test.** The spec has
   drifted badly and nothing validates it; `/hosts/resume`, the #762 route, has
   no published contract at all.
4. **Mechanical invariants for the two web-layer bugs** — no raw `fetch(` in
   server-side web code outside `lib/api.ts`/`proxy.ts`, and every `catch` under
   `services/web/src/app/**` routed through `lib/page-error.ts`.

Static analysis was already dense before this (oxlint, ~30 `no-mistakes` rules,
knip, dependency-cruiser, patch-coverage gates). The real hole was that the four
invariants `CLAUDE.md` states in prose were enforced by almost nothing — the repo
had exactly **one** `ast-grep` rule.

### Still open

Authenticated deployed probes — `/hosts`, resume, an unrouted write — need a
credential at deploy time. `smokeDeployment`'s own comment records that it
deliberately carries no private ingress credential, and no service-account key is
among the three SSM bootstrap parameters. Until that is decided, **the SSR-empty
class on the 12 authenticated pages is not covered by any automated check.**

## Known gaps

- **Cost model still needs a heavier run.** These sessions are short CLI
  calls — enough to prove the pipeline, not enough to fill
  [costs.md](costs.md) placeholders.
- **`services/cdk/cdk.out/` collides with the vitest glob.** After `synth`
  or a lifecycle command, `rm -rf services/cdk/cdk.out` before a local
  `vitest` run or it picks up bundled copies and fails with `Cannot find
package '@auto-harness/shared'`. CI starts clean, so this is local-only.
- **Slack / GitHub integration flows are out of scope.**
- **Host pane against a remote `WebUrl`** is a known auth seam (Phase 3);
  the expected outcome is recorded during the run, not assumed here.
