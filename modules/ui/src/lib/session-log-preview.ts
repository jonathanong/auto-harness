export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown, ...keys: string[]): string {
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field) return field;
  }
  return "";
}

export function toolPreview(itemType: string, item: Record<string, unknown>): string {
  if (itemType === "command_execution") {
    const code = item.exit_code;
    const exit = typeof code === "number" || typeof code === "string" ? `exit ${code}` : "";
    return [str(item, "command"), str(item, "status"), exit].filter(Boolean).join(" · ");
  }
  if (itemType === "file_change" && Array.isArray(item.changes)) {
    return item.changes
      .map((change) => {
        if (!isRecord(change)) return "";
        const path = str(change, "path");
        const slash = path.lastIndexOf("/");
        const name = slash >= 0 ? path.slice(slash + 1) : path;
        return [str(change, "kind"), name].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join(", ");
  }
  return str(item, "command", "name", "query", "id") || itemType;
}

export function eventPreview(type: string, value: Record<string, unknown>): string {
  if (type !== "turn.completed" || !isRecord(value.usage)) return type;
  const usage = value.usage;
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const parts = [
    input === undefined ? "" : `input ${input}`,
    output === undefined ? "" : `output ${output}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : type;
}

export function errorPreview(value: Record<string, unknown>): string {
  const nested = isRecord(value.error) ? value.error : undefined;
  return str(value, "message") || str(nested, "message") || str(value, "type") || "error";
}
