/**
 * An argv element as stored on a Session row. An element that contains the
 * session's prompt is stored as the text around its first occurrence, so the
 * row keeps one copy of the prompt in `prompt` rather than a second inside
 * `resolvedArgv`.
 */
export type StoredArgvElement = string | { before: string; after: string };

export function encodeStoredArgv(
  argv: readonly string[],
  prompt: string | undefined,
): StoredArgvElement[] {
  if (!prompt) return [...argv];
  return argv.map((arg) => {
    const at = arg.indexOf(prompt);
    return at < 0 ? arg : { before: arg.slice(0, at), after: arg.slice(at + prompt.length) };
  });
}

/**
 * The stored `resolvedArgv` for an assignment write, plus the condition that the
 * row's prompt is still the one the argv was encoded against.
 */
export function storedArgvAssignment(
  argv: readonly string[],
  prompt: string | undefined,
): {
  argv: StoredArgvElement[];
  condition: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  const stored = encodeStoredArgv(argv, prompt);
  if (!prompt) return { argv: stored, condition: "", names: {}, values: {} };
  return {
    argv: stored,
    condition: " AND #prompt = :prompt",
    names: { "#prompt": "prompt" },
    values: { ":prompt": prompt },
  };
}

/**
 * The compacted argv for a row written before argv was stored with the prompt factored
 * out, or null when the row does not repeat its prompt in plain string argv.
 */
export function legacyArgvCompaction(item: Record<string, unknown>): {
  prompt: string;
  argv: string[];
  stored: StoredArgvElement[];
} | null {
  const { prompt, resolvedArgv } = item;
  if (typeof prompt !== "string" || prompt === "" || !Array.isArray(resolvedArgv)) return null;
  if (!resolvedArgv.every((arg) => typeof arg === "string")) return null;
  const argv = resolvedArgv as string[];
  if (!argv.some((arg) => arg.includes(prompt))) return null;
  return { prompt, argv, stored: encodeStoredArgv(argv, prompt) };
}

/** Rebuild argv from a stored row; plain string elements pass through unchanged. */
export function decodeStoredArgv(stored: readonly unknown[], prompt: string | undefined): string[] {
  return stored.map((arg) => {
    if (typeof arg === "string") return arg;
    const { before, after } = arg as { before: string; after: string };
    return `${before}${prompt ?? ""}${after}`;
  });
}
