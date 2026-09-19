import type { DaemonConfig } from "./config-types.ts";

export function assignInventoryVersion(config: DaemonConfig, version: unknown): void {
  if (version === undefined) return;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("version must be a non-negative safe integer");
  }
  config.inventoryVersion = version;
}
