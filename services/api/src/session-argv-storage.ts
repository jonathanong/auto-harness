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

/** Rebuild argv from a stored row; plain string elements pass through unchanged. */
export function decodeStoredArgv(stored: readonly unknown[], prompt: string | undefined): string[] {
  return stored.map((arg) => {
    if (typeof arg === "string") return arg;
    const { before, after } = arg as { before: string; after: string };
    return `${before}${prompt ?? ""}${after}`;
  });
}
