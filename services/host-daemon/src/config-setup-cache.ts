import { presentSetupCacheHostInputs, presentSetupCacheInputs } from "@auto-harness/shared";

export function assignSetupCacheInputs<T extends { setupCacheInputs?: string[] }>(
  target: T,
  raw: Record<string, unknown>,
  ctx: string,
): void {
  const extras = presentSetupCacheInputs(raw.setupCacheInputs, ctx);
  if (extras) target.setupCacheInputs = extras;
}

export function assignSetupCacheHostInputs<T extends { setupCacheHostInputs?: string[] }>(
  target: T,
  raw: Record<string, unknown>,
  ctx: string,
): void {
  const extras = presentSetupCacheHostInputs(raw.setupCacheHostInputs, ctx);
  if (extras) target.setupCacheHostInputs = extras;
}
