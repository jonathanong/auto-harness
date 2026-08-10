export type SessionTarget =
  | { kind: "provider"; id: string; label: string; available?: boolean }
  | { kind: "command"; id: string; label: string; providerId?: string | null; available?: boolean };

export type SessionTargetSelection = { providerId: string } | { commandId: string };

const PROVIDER_PREFIX = "provider:";
const COMMAND_PREFIX = "command:";

/** Encode a target as a single `<select>` option value (`provider:<id>` / `command:<id>`). */
export function encodeSessionTargetOptionValue(target: Pick<SessionTarget, "id" | "kind">): string {
  return target.kind === "provider"
    ? `${PROVIDER_PREFIX}${target.id}`
    : `${COMMAND_PREFIX}${target.id}`;
}

/** Inverse of {@link encodeSessionTargetOptionValue}; `null` for an empty/unrecognized value. */
export function decodeSessionTargetOptionValue(value: string): SessionTargetSelection | null {
  if (value.startsWith(PROVIDER_PREFIX)) {
    const id = value.slice(PROVIDER_PREFIX.length);
    return id ? { providerId: id } : null;
  }
  if (value.startsWith(COMMAND_PREFIX)) {
    const id = value.slice(COMMAND_PREFIX.length);
    return id ? { commandId: id } : null;
  }
  return null;
}

/** Read the routing controls from a browser FormData while preserving DOM order. */
export function decodeSessionRoutingFormData(formData: {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}): {
  target: SessionTargetSelection | null;
  fallbacks: SessionTargetSelection[];
} {
  const target = decodeSessionTargetOptionValue(String(formData.get("target") ?? ""));
  const fallbacks = formData
    .getAll("fallback")
    .map((value) => decodeSessionTargetOptionValue(String(value)))
    .filter((value): value is SessionTargetSelection => value !== null);
  return { target, fallbacks };
}
