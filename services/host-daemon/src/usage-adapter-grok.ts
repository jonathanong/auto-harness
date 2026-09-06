import {
  record,
  structuredErrorCode,
  usageFromRecord,
  withUsage,
  type JsonRecord,
  type ParsedCliUsage,
} from "./usage-adapter-shared.ts";

// Grok CLI 1.0.13 `--output-format json` errors are `{type:"error", message}`
// with no structured code. HTTP 429 is mapped to ACP -32003, then
// `format_rate_limited_user_message` writes one of these three sentences
// (unicode apostrophe). Curly apostrophe is what the binary emits; ASCII is
// tolerated the same way as Codex. A generic "rate limit" phrase is not enough.
const GROK_USAGE_LIMIT_SENTENCE =
  /you['’]ve (?:hit (?:the rate limit for your plan|your team['’]s api rate limit)|reached your free grok build usage limit)/i;

// Grok CLI 1.0.13's separate HTTP-402 (billing) path: no `you've hit/reached`
// lead-in and no rate_limit_error/usage_limit code, because it isn't a 429 —
// the account's Grok Build credit balance is exhausted. This is grok's own
// error text (re-printed verbatim in the same `{type:"error"}` envelope's
// `message` field), not a generic "402"/"rate limit" phrase: both anchors —
// the exact HTTP status text and "usage balance exhausted" — are required
// together, per docs/host-daemon.md's policy that a bare status code is never
// sufficient evidence on its own.
const GROK_USAGE_BALANCE_EXHAUSTED_SENTENCE =
  /API error \(status 402 Payment Required\): Grok Build usage balance exhausted/i;

function grokUsageLimit(value: JsonRecord): boolean {
  if (value.type !== "error" && value.status !== "error") return false;
  const code = structuredErrorCode(value);
  if (code === "rate_limit_error" || code === "usage_limit") return true;
  if (typeof value.message !== "string") return false;
  return (
    GROK_USAGE_LIMIT_SENTENCE.test(value.message) ||
    GROK_USAGE_BALANCE_EXHAUSTED_SENTENCE.test(value.message)
  );
}

/**
 * Fold every top-level JSON object found in a grok capture, mirroring
 * `parseCodexRecords`' JSONL fold instead of trusting a single "last object"
 * pick. On its HTTP 402 (credit-exhausted) path grok's own CLI emits its
 * proper `{type:"error", message}` envelope once, then re-prints the same
 * failure as a plain-text `Error: Internal error: { ... }` line whose embedded
 * object also happens to parse as valid JSON but carries neither `type` nor
 * `status`. `jsonObject()`'s single "last complete object" pick would silently
 * prefer that trailing re-print over the real envelope and lose the
 * usage-limit signal entirely — see the incident fixture in
 * usage-adapter.test.ts. Folding every candidate means a signal from any one
 * of them wins, regardless of which candidate happens to come last.
 */
export function parseGrokRecords(
  candidates: readonly JsonRecord[],
  observedAt: string,
): ParsedCliUsage {
  let parsed: ParsedCliUsage = {};
  for (const value of candidates) {
    if (grokUsageLimit(value)) parsed = { ...parsed, usageLimit: true };
    if (typeof value.response === "string" || typeof value.text === "string") {
      const usage = record(value.usage);
      if (usage) parsed = { ...parsed, ...withUsage(usageFromRecord(usage, observedAt, "grok")) };
    }
  }
  return parsed;
}
