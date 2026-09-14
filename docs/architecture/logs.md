# Logs and archives

Log **bodies** live in S3, not DynamoDB. The control plane shows a **polled** S3 view. A live
PTY-quality stream exists only on the **host pane** (loopback to the daemon). Autonomous default:
**do not upload** session logs at all.

Invariant 13: REST is a bounded page. Viewer WebSocket does **not** carry log text.

```mermaid
flowchart TB
    CLI["AI CLI / setup / hook"] --> Agent
    Agent -->|"loopback stream"| HostPane["Host pane live tail"]
    Agent -->|"gzip parts when upload on"| S3["S3 sessions/id/parts then logs.jsonl.gz"]
    S3 -->|"GET /sessions/:id/logs poll"| CP["Control-plane UI"]
    S3 -->|"GET /sessions/:id/archive"| CP
    Agent -->|"session:log-part if subscribed"| Viewers["Viewer WS notify only"]
```

| Surface                          | Bound                       | Live?                  | Store                         |
| -------------------------------- | --------------------------- | ---------------------- | ----------------------------- |
| Host pane                        | Local daemon stream         | Yes                    | Process memory / PTY          |
| Control-plane UI                 | REST page, poll interval    | Near-real-time at poll | S3 parts or final gzip        |
| Viewer WebSocket                 | Optional `session:log-part` | Notify only            | No body                       |
| REST `GET /sessions/:id/archive` | One version-pinned object   | After terminal         | `sessions/{id}/logs.jsonl.gz` |

## Operator settings

Structured control-plane Settings form (host pane may mirror; it is never the only editor).

| Knob               | Default | Meaning                                             |
| ------------------ | ------- | --------------------------------------------------- |
| Upload mode        | `off`   | `off` / `subscribed` / `always`                     |
| Batch max KB       | 256     | Uncompressed JSONL bytes before a part flush        |
| Batch max lines    | 500     | JSONL lines before a part flush                     |
| Batch max time     | 60s     | Flush pending output at least this often            |
| Control-plane poll | 60s     | Browser REST poll while the session is non-terminal |

`subscribed`: the host uploads only while at least one control-plane viewer is registered (fan-out
of **part keys**, not log text). EventBridge remains a 1-minute **repair sweep**, not this poll.

## S3 layout

| Key                                                       | When                                            |
| --------------------------------------------------------- | ----------------------------------------------- |
| `sessions/{sessionId}/parts/{seqStart}-{seqEnd}.jsonl.gz` | Each flush                                      |
| `sessions/{sessionId}/logs.jsonl.gz`                      | Terminal: host concatenates parts into one gzip |

Do **not** use S3 multipart upload for these parts: minimum part size is **5 MB** except the last
part. Staging is ordinary `PutObject` of gzip members; the host concatenates (gzip members may be
concatenated, or recompressed as one member) into the final key.

The host PUTs with **per-part presigned URLs** (long sessions outlive a single assign-time URL).
WebSocket Lambda still has **no** S3 grant. REST/Cron keep `sessions/*` Put/Get. DynamoDB
`Archives` rows remain pointer/`versionId`/retry metadata only.

## Control plane vs host pane

The control plane **must** still show the transcript (invariant 10) via S3 poll. Copy on that view:

> Near-real-time via S3. For a live PTY stream, open the host pane on that machine.

The host pane streams from the daemon on loopback. It is debug-only; it is not required to **read**
a finished archive.

## Why not other AWS stores

| Store                              | Why not here                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| DynamoDB `SessionLogs`             | 27M transact writes/month at the old 10 msg/s path; wrong shape for bodies                      |
| S3 Express One Zone                | Single AZ; directory buckets; latency we do not need; request $ ≈ Dynamo if still 27M tiny PUTs |
| Kinesis / Firehose                 | Ingest bus, not `GET last page for session X`; Firehose 5 KB round-up                           |
| CloudWatch Logs                    | Ops product; no attempt-fenced `seq` page                                                       |
| MSK / Redis / OpenSearch / AppSync | Cluster floor or more expensive fan-out than API Gateway WS                                     |

Batch on the host + Standard S3 parts is the cost lever. See [costs.md](../costs.md).

## Related

[communication.md](communication.md) · [request-lifetime.md](request-lifetime.md) · [costs.md](../costs.md) · [websocket.md](../websocket.md) · [aws.md](../aws.md)
