type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse a single provider JSON envelope, never JSON embedded in model text. */
export function jsonObject(output: string): JsonRecord | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
