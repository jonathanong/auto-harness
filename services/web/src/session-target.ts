export type SessionTarget =
  | { kind: "provider-account"; id: string; label: string; providerId: string }
  | { kind: "command"; id: string; label: string };

type SessionTargetSelection = { providerAccountId: string } | { commandId: string };

const ACCOUNT_PREFIX = "account:";
const COMMAND_PREFIX = "command:";

/** Encode a target as a single `<select>` option value (`account:<id>` / `command:<id>`). */
export function encodeSessionTargetOptionValue(target: Pick<SessionTarget, "id" | "kind">): string {
  return target.kind === "provider-account"
    ? `${ACCOUNT_PREFIX}${target.id}`
    : `${COMMAND_PREFIX}${target.id}`;
}

/** Inverse of {@link encodeSessionTargetOptionValue}; `null` for an empty/unrecognized value. */
export function decodeSessionTargetOptionValue(value: string): SessionTargetSelection | null {
  if (value.startsWith(ACCOUNT_PREFIX)) {
    const id = value.slice(ACCOUNT_PREFIX.length);
    return id ? { providerAccountId: id } : null;
  }
  if (value.startsWith(COMMAND_PREFIX)) {
    const id = value.slice(COMMAND_PREFIX.length);
    return id ? { commandId: id } : null;
  }
  return null;
}
