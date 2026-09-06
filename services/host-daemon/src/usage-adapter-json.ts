type JsonRecord = Record<string, unknown>;

// PTYs can surround the one structured provider envelope with control
// sequences or status diagnostics. Keep scanning bounded even when a broken
// CLI produces an unbounded stream; callers capture the same maximum.
const MAX_JSON_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_ENVELOPE_CANDIDATES = 64;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse every complete top-level JSON object from a bounded PTY capture, in
 * the order they appear.
 *
 * Provider wrappers may write terminal control sequences or diagnostics before
 * and after their JSON result. This scanner only extracts balanced objects,
 * respecting quoted braces and escapes; provider-specific callers still have
 * to validate each candidate envelope before any telemetry is accepted.
 */
export function jsonObjects(output: string): JsonRecord[] {
  if (!output || Buffer.byteLength(output, "utf8") > MAX_JSON_ENVELOPE_BYTES) return [];
  const results: JsonRecord[] = [];
  let candidates = 0;
  for (
    let start = 0;
    start < output.length && candidates < MAX_JSON_ENVELOPE_CANDIDATES;
    start += 1
  ) {
    if (output[start] !== "{") continue;
    const end = objectEnd(output, start);
    if (end === undefined) continue;
    candidates += 1;
    try {
      const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
      if (isRecord(parsed)) results.push(parsed);
      start = end;
    } catch {
      // This may have been a brace in a diagnostic. Continue from the next
      // character so a later standalone provider envelope remains discoverable.
    }
  }
  return results;
}

/**
 * The last complete top-level JSON object from a bounded PTY capture — the
 * common case where a single provider envelope is expected. Callers that must
 * not let a trailing diagnostic re-print shadow an earlier real envelope (see
 * grok's usage-limit handling in usage-adapter.ts) should use `jsonObjects`
 * directly and validate each candidate instead.
 */
export function jsonObject(output: string): JsonRecord | undefined {
  return jsonObjects(output).at(-1);
}

function objectEnd(value: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (inString) {
      ({ inString, escaped } = nextStringState(char, escaped));
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function nextStringState(
  char: string,
  escaped: boolean,
): {
  inString: boolean;
  escaped: boolean;
} {
  if (escaped) return { inString: true, escaped: false };
  if (char === "\\") return { inString: true, escaped: true };
  return { inString: char !== '"', escaped: false };
}

/** Parse Codex's JSONL event stream; each accepted line remains a full envelope. */
export function jsonLines(output: string): JsonRecord[] {
  const objects: JsonRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) objects.push(parsed);
    } catch {
      // Non-JSON diagnostics cannot become telemetry.
    }
  }
  return objects;
}
