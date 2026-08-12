# Integrations

## Slack

> **Current status:** Auto Harness can create, read, replace, and delete an encrypted, redacted
> Slack configuration through the admin API and Web UI. It does not yet call Slack, perform OAuth
> or inbound verification, create session threads, or deliver lifecycle messages. The delivery
> flow below is the promised end state.

For **fire-and-forget** callers (e.g. GitHub Actions `POST /sessions` then exit), humans do **not** watch the trigger job. They listen via:

| Channel    | What they see                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| **Slack**  | Target: session lifecycle thread (queued → running → done/fail) from Auto Harness                         |
| **GitHub** | PRs, issue/PR comments, reviews, checks—repo updates produced by the agent session (or follow-on tooling) |

Auto Harness will own the **Slack** session thread once delivery is implemented. **GitHub** updates depend on what the session is allowed to do on the VPS (git/`gh` credentials on the agent host)—not on the Actions run that kicked it off.

The target delivery behavior posts real-time session updates to Slack: each session gets a thread in a configured channel, updated as the session progresses.

### Delivery setup (target)

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add the `chat:write` OAuth scope
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (`xoxb-...`)
5. Configure the integration via the API or Web UI

### Configuration

#### `POST /api/v1/integrations/slack`

Configure Slack integration. **Admin only.**

**Request:**

```json
{
  "botToken": "xoxb-...",
  "defaultChannel": "#harness",
  "enabled": true,
  "notifications": {
    "onSessionCreated": true,
    "onSessionStarted": true,
    "onSessionCompleted": true,
    "onSessionFailed": true,
    "onSessionCancelled": true,
    "onScheduleCompleted": false
  }
}
```

| Field            | Type    | Required | Description                                                        |
| ---------------- | ------- | -------- | ------------------------------------------------------------------ |
| `botToken`       | string  | ✓        | Slack Bot User OAuth Token (`xoxb-...`)                            |
| `defaultChannel` | string  | ✓        | Default channel for notifications (e.g. `#harness`, `C0123ABCDEF`) |
| `enabled`        | boolean | ✗        | Default: `true`                                                    |
| `notifications`  | object  | ✗        | Toggle which events post to Slack                                  |

> **Note:** The bot token is encrypted at rest in DynamoDB using AWS KMS.
> `KMS_KEY_ID` is required for configuration writes. Ciphertext is bound to the
> stable Slack integration encryption context, and the API never returns, logs,
> or audits bot tokens or optional signing secrets. Missing KMS configuration or
> encryption failures fail the write closed.

#### `GET /api/v1/integrations/slack`

Get current Slack configuration (token is redacted).

#### `PUT /api/v1/integrations/slack`

Update Slack configuration. **Admin only.**

`PUT` replaces the complete configuration and therefore includes `botToken`.
This slice configures storage only: it does not implement Slack OAuth, incoming
event verification, message delivery, or session-thread lifecycle.

#### `DELETE /api/v1/integrations/slack`

Remove Slack integration. **Admin only.**

### Per-Repository Overrides

Repositories can override the default Slack channel:

```json
{
  "name": "my-app",
  "url": "git@github.com:org/my-app.git",
  "defaultBranch": "main",
  "slackChannel": "#my-app-auto-harness"
}
```

If not set, the default channel from the integration config is used.

### Thread Lifecycle (target)

Each session creates a Slack thread that tracks the full lifecycle:

```mermaid
sequenceDiagram
    participant Lambda
    participant Slack as Slack API
    participant Channel as #harness

    Note over Lambda: Session created
    Lambda->>Slack: chat.postMessage
    Slack-->>Channel: 📋 New session queued
    Note over Slack: Returns thread_ts

    Note over Lambda: Session started
    Lambda->>Slack: chat.postMessage (thread_ts)
    Slack-->>Channel: ▶️ Session started (thread reply)

    Note over Lambda: Session completed
    Lambda->>Slack: chat.postMessage (thread_ts)
    Slack-->>Channel: ✅ Session completed (thread reply)

    Lambda->>Slack: chat.update (thread_ts)
    Slack-->>Channel: Update original message with final status
```

### Message Format

#### Session Created (channel message — starts the thread)

```
📋 Session queued — my-app
━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt: Fix the failing test in src/utils.test.ts
Command: codex -p
Priority: 10
Source: ui (jong)
```

#### Session Started (thread reply)

```
▶️ Session started
Agent: vps-prod-1
Worktree: wt-2
```

#### Session Completed (thread reply + update original)

```
✅ Session completed in 5m 32s
Exit code: 0
```

The original channel message is also updated to show the final status:

```
✅ Session completed — my-app (5m 32s)
━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt: Fix the failing test in src/utils.test.ts
Command: codex -p
Exit code: 0
```

#### Session Failed (thread reply + update original)

```
❌ Session failed after 2m 15s
Exit code: 1

Last 5 lines of stderr:
> Error: Cannot find module './parser'
> at Object.<anonymous> (src/utils.ts:12:1)
> ...
```

When `errorCode` is `usage_limit` (AI vendor quota / rate limit parsed by the agent):

```
❌ Session failed — usage limit
The AI CLI reported a plan or rate limit. Auto Harness pauses the assigned
Provider Account globally for its configured cooldown (5 hours by default),
then tries the next eligible account or configured fallback. Providerless
commands (`providerId: null`) are ungated and do not pause an account. A queued
session expires after its absolute queue TTL (8 days by default) with
`queue_expired`.
```

The original message is updated with ❌ status. The thread includes the last few lines of stderr to aid quick debugging without opening the UI.

#### Session Cancelled (thread reply + update original)

```
⚪ Session cancelled by jong
```

### Thread Metadata (target)

The Slack `thread_ts` (thread timestamp) is stored on the Session record in DynamoDB so that subsequent status updates can reply to the correct thread:

```typescript
// Session record in DynamoDB
{
  id: "sess-x1y2z3",
  // ... other fields
  slackThreadTs: "1722556800.001234",
  slackChannel: "C0123ABCDEF"
}
```

### Rate Limiting (target)

The delivery implementation must respect Slack API rate limits and batch updates:

- Log streaming is **not** sent to Slack (too noisy). Logs are only available in the Web UI (link the session from the thread when useful).
- Once delivery ships, fire-and-forget CI callers can rely on Slack (and GitHub repo activity) for humans; the trigger Actions run does not carry live agent logs.
- Status updates are sent immediately (queued → started → completed/failed).
- If multiple sessions complete in rapid succession, messages are queued and sent with a 1-second delay between each.

### Permissions Required

| Slack OAuth Scope | Purpose                               |
| ----------------- | ------------------------------------- |
| `chat:write`      | Post messages and replies to channels |

The bot must be invited to the target channel(s) via `/invite @auto-harness-bot`.

---

## Future Integrations

### GitHub Actions (caller pattern)

**Fire and forget** — not a long-running Actions job:

1. Event triggers a short workflow (failure, comment, schedule, …).
2. Workflow calls Auto Harness **`POST /sessions`** (service account).
3. Workflow **exits**; it does not poll session status.
4. Today, humans follow **GitHub** (PRs/comments/checks) and the UI/logs. Once Slack delivery ships,
   its session thread becomes the fire-and-forget notification path.

**Target requirements:** Slack delivery enabled for unattended runs; session id returned on create;
no need for GHA to poll. Until delivery ships, use GitHub activity or the UI instead. Worked
examples: [harness.md](harness.md).

### Custom Webhooks (Outbound)

**Target only:** optional machine-to-machine callbacks if something other than Slack must react to
terminal status. The current API can record a configured URL and a would-be delivery in
in-process state, but it does not make an outbound HTTP request. Webhooks are **not required** for
the GHA fire-and-forget + Slack pattern.

```json
{
  "url": "https://your-service.com/auto-harness-webhook",
  "events": ["session:completed", "session:failed", "session:timed_out", "session:cancelled"],
  "secret": "webhook-signing-secret"
}
```

### Email Notifications

Optional email notifications on session completion/failure via Amazon SES.
