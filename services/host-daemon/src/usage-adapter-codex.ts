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

/** Parse Codex's JSONL event stream, tracking terminal usage and Codex's own error envelopes. */
export function parseCodexRecords(values: JsonRecord[], observedAt: string): ParsedCliUsage {
  let parsed: ParsedCliUsage = {};
  for (const value of values) {
    if (value.type === "turn.completed") {
      const usage = record(value.usage);
      if (usage) parsed = { ...parsed, ...withUsage(usageFromRecord(usage, observedAt, "codex")) };
    }
    if (codexUsageLimit(value)) {
      parsed = { ...parsed, usageLimit: true };
    }
  }
  return parsed;
}
