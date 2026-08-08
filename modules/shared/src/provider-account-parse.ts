/** Shared strict-parsing helpers for provider-account host inventory fields. */

export type ParsedProviderAccountOverride = { enabled?: boolean; commandId?: string };
export type ParsedHostProviderAccount = { providerAccountId: string; commandId?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${ctx}: ${key} must be a non-empty string`);
  }
  return value;
}

/** Parses `providerAccountOverrides` on a repository or worktree. `undefined` input -> `undefined` (inherit). */
export function parseProviderAccountOverrides(
  raw: unknown,
  ctx: string,
): Record<string, ParsedProviderAccountOverride> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`${ctx}.providerAccountOverrides must be an object`);
  }
  const out: Record<string, ParsedProviderAccountOverride> = {};
  for (const [acctId, rawOverride] of Object.entries(raw)) {
    if (!isRecord(rawOverride)) {
      throw new Error(`${ctx}.providerAccountOverrides.${acctId} must be an object`);
    }
    const override: ParsedProviderAccountOverride = {};
    if (rawOverride.enabled !== undefined) {
      if (typeof rawOverride.enabled !== "boolean") {
        throw new Error(`${ctx}.providerAccountOverrides.${acctId}.enabled must be a boolean`);
      }
      override.enabled = rawOverride.enabled;
    }
    if (rawOverride.commandId !== undefined) {
      if (typeof rawOverride.commandId !== "string" || rawOverride.commandId.length === 0) {
        throw new Error(
          `${ctx}.providerAccountOverrides.${acctId}.commandId must be a non-empty string`,
        );
      }
      override.commandId = rawOverride.commandId;
    }
    out[acctId] = override;
  }
  return out;
}

/** Parses top-level `providerAccounts` on a host inventory. `undefined` input -> `[]`. */
export function parseProviderAccounts(raw: unknown): ParsedHostProviderAccount[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("providerAccounts must be an array");
  }
  return raw.map((rawAcct, i) => {
    if (!isRecord(rawAcct)) {
      throw new Error(`providerAccounts[${i}] must be an object`);
    }
    const providerAccountId = requireString(rawAcct, "providerAccountId", `providerAccounts[${i}]`);
    const acct: ParsedHostProviderAccount = { providerAccountId };
    if (rawAcct.commandId !== undefined) {
      if (typeof rawAcct.commandId !== "string" || rawAcct.commandId.length === 0) {
        throw new Error(`providerAccounts[${i}].commandId must be a non-empty string`);
      }
      acct.commandId = rawAcct.commandId;
    }
    return acct;
  });
}
