import { jsonObjects } from "./usage-adapter-json.ts";
import {
  record,
  usageFromRecord,
  withUsage,
  type JsonRecord,
  type ParsedCliUsage,
} from "./usage-adapter-shared.ts";

// Real cursor-agent 2026.09.10 out-of-usage failure (2026-10-05): ~20s after spawn it writes
// one plain-text line on stdout (not a JSON envelope), followed by a `\x1b[?25h` cursor-show
// escape, then exits 1. Both anchors are required: the CLI's own error class prefix and its
// "out of usage" sentence.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ESCAPE_SEQUENCES = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\))`,
  "g",
);
const USAGE_LIMIT_LINE = /^ActionRequiredError:.*\bout of usage\b/i;

/**
 * In `--output-format json` mode agent-generated content can only appear inside the final
 * `{"type":"result"}` envelope, so a plain-text limit line is CLI-owned only when no result
 * envelope was emitted at all. Callers still gate on a failed exit (`detectUsageLimit`).
 */
export function parseCursorOutput(output: string, observedAt: string): ParsedCliUsage {
  const envelope = jsonObjects(output)
    .filter((value) => value.type === "result")
    .at(-1);
  if (envelope) return parseCursorRecord(envelope, observedAt);
  return hasUsageLimitLine(output) ? { usageLimit: true } : {};
}

function hasUsageLimitLine(output: string): boolean {
  return output
    .replace(ESCAPE_SEQUENCES, "")
    .split(/\r\n|\r|\n/)
    .some((line) => USAGE_LIMIT_LINE.test(line.trim()));
}

function parseCursorRecord(value: JsonRecord, observedAt: string): ParsedCliUsage {
  if (
    value.type !== "result" ||
    typeof value.subtype !== "string" ||
    typeof value.is_error !== "boolean"
  ) {
    return {};
  }
  const usage = record(value.usage);
  return {
    ...(usage ? withUsage(usageFromRecord(usage, observedAt, "cursor")) : {}),
    ...(typeof value.result === "string" ? { agentSummary: value.result } : {}),
  };
}
