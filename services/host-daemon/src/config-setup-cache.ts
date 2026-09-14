import { presentSetupCacheHostInputs, presentSetupCacheInputs } from "@auto-harness/shared";

import { isForeignWindowsAbsolutePath } from "./allowed-roots.ts";

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
  if (!extras) return;
  // Control-plane parsing accepts Windows/UNC spellings for mixed fleets; a POSIX
  // daemon must not treat those as cwd-relative names (same fence as terminal hooks).
  for (const path of extras) {
    if (isForeignWindowsAbsolutePath(path)) {
      throw new Error(`${ctx} is not valid on ${process.platform}: ${path}`);
    }
  }
  target.setupCacheHostInputs = extras;
}
