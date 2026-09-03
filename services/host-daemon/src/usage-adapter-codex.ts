import {
  record,
  structuredErrorCode,
  usageFromRecord,
  withUsage,
  type JsonRecord,
  type ParsedCliUsage,
} from "./usage-adapter-shared.ts";

const CODEX_ERROR_TYPES = new Set(["turn.failed", "error"]);
// One user-facing sentence codex's own CLI error path emits verbatim (never model-authored).
// codex-cli has ~7 variants of this sentence with different trailing clauses/punctuation —
// do not anchor on a suffix. Curly apostrophe tolerated defensively; the binary only emits ASCII.
const CODEX_USAGE_LIMIT_SENTENCE = /you['’]ve hit your usage limit/i;

/**
 * Codex's own error envelope only — `{"type":"error"}` (top-level) or `turn.failed.error`.
 * By construction this never reads `item.*` content, which is model-authored and untrusted.
 * Only called once `codexUsageLimit` has confirmed `value.type` is one of `CODEX_ERROR_TYPES`.
 */
function codexErrorMessage(value: JsonRecord): string | undefined {
  if (value.type === "error") {
    return typeof value.message === "string" ? value.message : undefined;
  }
  const error = record(value.error);
  return typeof error?.message === "string" ? error.message : undefined;
}

function codexUsageLimit(value: JsonRecord): boolean {
  if (!CODEX_ERROR_TYPES.has(typeof value.type === "string" ? value.type : "")) return false;
  // Keep the structured-code check as a forward-compatible arm in case OpenAI adds one later.
  const code = structuredErrorCode(value);
  if (code === "insufficient_quota" || code === "rate_limit_error") return true;
  const message = codexErrorMessage(value);
  return typeof message === "string" && CODEX_USAGE_LIMIT_SENTENCE.test(message);
}

/** Fold one decoded JSONL record into a running `ParsedCliUsage` accumulator. */
export function foldCodexRecord(
  parsed: ParsedCliUsage,
  value: JsonRecord,
  observedAt: string,
): ParsedCliUsage {
  let next = parsed;
  if (value.type === "turn.completed") {
    const usage = record(value.usage);
    if (usage) next = { ...next, ...withUsage(usageFromRecord(usage, observedAt, "codex")) };
  }
  if (codexUsageLimit(value)) {
    next = { ...next, usageLimit: true };
  }
  return next;
}

/** Parse Codex's JSONL event stream, tracking terminal usage and Codex's own error envelopes. */
export function parseCodexRecords(values: JsonRecord[], observedAt: string): ParsedCliUsage {
  let parsed: ParsedCliUsage = {};
  for (const value of values) {
    parsed = foldCodexRecord(parsed, value, observedAt);
  }
  return parsed;
}

// A JSONL line is normally a few KB. This only guards a single unterminated
// fragment against an unbounded/broken stream; it is not a whole-output cap.
export const CODEX_PENDING_LINE_MAX_BYTES = 1024 * 1024;

export interface CodexUsageStream {
  push(chunkData: string): void;
  finish(): ParsedCliUsage;
}

/**
 * Incrementally fold Codex's JSONL stream as PTY chunks arrive, so a long run
 * still yields usage/usage-limit signal even if it never reaches a terminal
 * line within any single-buffer cap. `observedAt` is fixed at construction —
 * one run shares one timestamp, mirroring the prior whole-buffer behavior.
 */
export function createCodexUsageStream(observedAt: string): CodexUsageStream {
  let pending = "";
  let parsed: ParsedCliUsage = {};

  function foldLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const value = JSON.parse(trimmed) as unknown;
      const decoded = record(value);
      if (decoded) parsed = foldCodexRecord(parsed, decoded, observedAt);
    } catch {
      // Non-JSON diagnostics cannot become telemetry, matching jsonLines().
    }
  }

  return {
    push(chunkData: string): void {
      const combined = pending + chunkData;
      const lines = combined.split(/\r?\n/);
      const tail = lines.pop()!; // split() always returns at least one element
      for (const line of lines) foldLine(line);
      // Drop an oversized unterminated fragment and resync at the next newline
      // rather than growing `pending` unbounded.
      pending = Buffer.byteLength(tail, "utf8") > CODEX_PENDING_LINE_MAX_BYTES ? "" : tail;
    },
    finish(): ParsedCliUsage {
      if (pending) foldLine(pending);
      return parsed;
    },
  };
}
