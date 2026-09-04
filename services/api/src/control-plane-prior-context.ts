import { MAX_PRIOR_CONTEXT_BYTES } from "@auto-harness/shared";

import type { LogQuery, LogRecord } from "./control-plane-types.ts";
import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { getLogsDurable, getSessionDurable } from "./control-plane-durable-read-runtime.ts";
import { selectLogs } from "./log-query.ts";

/** Bound on the number of durable log records fetched before the byte cap is applied.
 * Read as the newest N (`order: "desc"`), so the byte cap trims the least-recent end. */
const PRIOR_CONTEXT_LOG_RECORDS = 4_000;

/** The source prompt is included for orientation, not as a second full copy of the session. */
const MAX_PROMPT_EXCERPT_BYTES = 2 * 1024;

export type PriorSessionContext = {
  sourceSessionId: string;
  content: string;
  truncated: boolean;
};

type PriorContextSource = Pick<
  SessionRecord,
  "id" | "status" | "errorCode" | "errorMessage" | "completedAt" | "prompt"
>;

function truncateUtf8Head(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Never split a multi-byte UTF-8 codepoint: back up over trailing continuation bytes.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

function truncateUtf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { text: new TextDecoder().decode(bytes.subarray(start)), truncated: true };
}

function streamPrefix(stream: string): string {
  if (stream === "stdout") return "";
  return `[${stream}] `;
}

/**
 * Render a bounded, plain-markdown transcript of a terminal session for a
 * *different* session to read as a file. Not the archived NDJSON: this exists
 * to be read and grepped by a model, and NDJSON forces it to parse.
 *
 * No redaction pass here — `ResumeRefCaptureReader` already replaces a
 * matching CLI-resume-reference line with a redacted placeholder before it
 * ever reaches `streamer.write`, so it was never durably logged, and
 * `sanitizeGitDiagnostic` already scrubs git credentials out of `system`
 * lines before they are logged. Do not add a second pass here.
 */
export function renderPriorSessionContext(
  source: PriorContextSource,
  logs: readonly LogRecord[],
): { content: string; truncated: boolean } | null {
  if (logs.length === 0) return null;
  const prompt = truncateUtf8Head(source.prompt, MAX_PROMPT_EXCERPT_BYTES);
  // errorMessage is caller-supplied free text with no size bound elsewhere in the
  // schema; cap it too so a pathological message cannot consume the whole budget
  // and starve the transcript body.
  const errorMessage = source.errorMessage
    ? truncateUtf8Head(source.errorMessage, MAX_PROMPT_EXCERPT_BYTES)
    : undefined;
  const header = [
    `# Prior session ${source.id}`,
    "",
    `- Status: ${source.status}`,
    ...(source.errorCode ? [`- Error code: ${source.errorCode}`] : []),
    ...(errorMessage ? [`- Error: ${errorMessage.text}${errorMessage.truncated ? "…" : ""}`] : []),
    ...(source.completedAt ? [`- Completed at: ${source.completedAt}`] : []),
    "",
    "## Original prompt",
    "",
    prompt.text + (prompt.truncated ? "…" : ""),
    "",
    "## Transcript",
    "",
  ].join("\n");
  const body = logs.map((log) => `${streamPrefix(log.stream)}${log.content}`).join("\n");
  const headerBytes = new TextEncoder().encode(header).length;
  const bodyBudget = Math.max(0, MAX_PRIOR_CONTEXT_BYTES - headerBytes);
  const trimmedBody = truncateUtf8Tail(body, bodyBudget);
  const truncated = trimmedBody.truncated || logs.length >= PRIOR_CONTEXT_LOG_RECORDS;
  const notice = truncated
    ? "> Truncated: showing only the most recent portion of this transcript.\n\n"
    : "";
  return { content: header + notice + trimmedBody.text + "\n", truncated };
}

function boundedQuery(): LogQuery {
  return { limit: PRIOR_CONTEXT_LOG_RECORDS, order: "desc" };
}

/**
 * Load and render the transcript of `sourceSessionId` for a fallback resume
 * continuation. Never throws: a missing session, a missing/expired
 * transcript (`SessionLogs` carries a 7-day TTL), or any storage error all
 * return `null` — the caller must treat that as "no context available," not
 * as a reason to fail the resume or the assignment.
 */
export async function loadPriorSessionContextDurable(
  state: ControlPlaneState,
  sourceSessionId: string,
): Promise<PriorSessionContext | null> {
  try {
    const source = await getSessionDurable(state, sourceSessionId);
    if (!source) return null;
    const logs = await getLogsDurable(state, sourceSessionId, boundedQuery());
    const rendered = renderPriorSessionContext(source, logs);
    return rendered && { sourceSessionId, ...rendered };
  } catch {
    return null;
  }
}

/** Synchronous, storage-less counterpart used by the in-memory (non-durable) control plane. */
export function loadPriorSessionContextLocal(
  state: ControlPlaneState,
  sourceSessionId: string,
): PriorSessionContext | null {
  const source = state.sessions.get(sourceSessionId);
  if (!source) return null;
  const logs = selectLogs(state.logs.get(sourceSessionId) ?? [], boundedQuery());
  const rendered = renderPriorSessionContext(source, logs);
  return rendered && { sourceSessionId, ...rendered };
}
