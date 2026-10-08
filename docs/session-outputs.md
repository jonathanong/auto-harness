# Session output and artifacts

Sessions can publish a JSON output and a downloadable archive of files. These are optional,
independent of transcript upload settings, and separate from the harness's `result` summary,
branch, changed-files, and pull-request fields.

## Writing files

A daemon advertising `session-outputs` gives each attempt two fresh absolute paths:

| Environment variable    | Purpose                                                   | Limit                                               |
| ----------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `HARNESS_OUTPUT_FILE`   | Write one UTF-8 JSON document                             | 256 KiB                                             |
| `HARNESS_ARTIFACTS_DIR` | Write files and subdirectories for one `artifacts.tar.gz` | 100 MiB compressed, 1 GiB source data, 10,000 files |

The prompt explains these optional locations. Commands with `appendPrompt: false` still receive
the environment variables. Terminal hooks receive the same paths, so they can add diagnostics.
The paths are daemon-owned, outside the repository checkout, and cannot reuse another attempt's
files. Resume and child sessions get their own locations.

For example, a Node-based command or hook can write:

```js
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

await writeFile(process.env.HARNESS_OUTPUT_FILE, JSON.stringify({ passed: true, count: 12 }));
await writeFile(join(process.env.HARNESS_ARTIFACTS_DIR, "report.txt"), "12 checks passed\n");
```

Any JSON value is accepted, including arrays, strings, numbers, booleans, and `null`. A missing
file means no JSON output; an empty or malformed file is an error. JSON is never truncated.
An empty artifact directory means no artifact archive. Relative directory structure is preserved.
Symlinks, special files, escaping paths, and files that change during collection are rejected
rather than included in an incomplete archive.

## Completion and availability

The daemon collects after terminal hooks on completion, failure, cancellation, and timeout,
before workspace cleanup. Deferred hooks collect only after their final disposition. Files from
an attempt accepted for an infrastructure retry cannot replace the next attempt's output.

Collection and upload errors do not change the command's terminal status. JSON and artifacts
publish independently. The daemon durably stages publishing work before reporting completion,
then retries transient upload failures in the background for up to 24 hours. Restarting the
daemon resumes staged jobs; retry count, concurrency, transfer duration, and disk usage are bounded.
The session may therefore be completed while its output is still pending. If a host is lost
before files are staged, the control plane cannot reconstruct those files from the transcript.

| State         | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `unsupported` | The assigned daemon did not support session outputs.                                        |
| `pending`     | Execution, collection, or publishing is still in progress.                                  |
| `none`        | Collection finished without files for this output type.                                     |
| `ready`       | JSON is stored, or the artifact object was verified and can be downloaded.                  |
| `error`       | Collection, validation, or publishing failed; a bounded error code and message describe it. |

## Reading output

Use `GET /api/v1/sessions/:id/output` or `auto-harness session output <id>`:

```json
{
  "state": "ready",
  "output": { "passed": true, "count": 12 },
  "capturedAt": "2026-10-08T14:00:00.000Z"
}
```

Use `GET /api/v1/sessions/:id/artifacts` or `auto-harness session artifacts <id>` for the
archive's availability and a fresh download URL. A ready response includes `downloadUrl`,
`expiresAt`, `capturedAt`, `contentType`, `filename`, `compressedBytes`, and `sha256`.
Download links expire after five minutes; request a fresh link for each download and do not
persist or log it. The session detail view displays the JSON and provides artifact download.

Both endpoints use existing session visibility rules. Missing and inaccessible sessions return
`404`; successful responses use `Cache-Control: no-store`. `ready` with `output: null` is distinct
from `none`.

## Local API deployments

Without an archive bucket, the API keeps artifact archives on its local disk. For a remote
local/VPS API, set `HARNESS_API_PUBLIC_BASE_URL` to the externally reachable API origin, for
example `https://api.example.com`. Upload and download links use that address; a bind address
such as `0.0.0.0` is not a public address. `HARNESS_PUBLIC_BASE_URL` remains the control-plane
UI origin.

## Storage and retention

JSON text and compact collection metadata live in the dedicated DynamoDB `SessionOutputs`
table, separately from frequently updated session and lease records. Artifacts use a fixed,
attempt-specific key under `sessions/{sessionId}/artifacts/` in the existing archive bucket.
Readers use a verified immutable object version. Transcript readers only inspect recognized
log keys, so artifact archives are not parsed as JSONL.

Outputs and artifacts use the existing `sessionRetentionDays` policy: 30 days by default,
configurable from 1 to 3650 days in Settings. Retention cleanup deletes output records, all artifact
object versions, and the session; old links then return not found. Pending transfers do not
retain sessions indefinitely. Deletion fences new publishing and waits beyond outstanding
upload authorizations and bounded in-flight transfers before final object cleanup.

Deploy the table, API, and bucket permissions before updating daemons. Older daemons remain
schedulable and return `unsupported`; no historical output backfill is performed. The daemon's
prepare/upload/complete protocol uses its host credential, never a credential stored in artifact
files or passed to the agent.
