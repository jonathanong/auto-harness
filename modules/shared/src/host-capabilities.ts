/** Explicit feature support advertised by a connected host daemon. */
export const HOST_CAPABILITIES = ["scheduled-main-checkout"] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

/**
 * Capability arrays are deliberately additive: an omitted field from an older
 * daemon means it supports no optional features.
 */
export type HostCapabilities = HostCapability[];

export function isHostCapability(value: unknown): value is HostCapability {
  return typeof value === "string" && (HOST_CAPABILITIES as readonly string[]).includes(value);
}

/** Canonicalize an optional wire/storage value without retaining duplicates. */
export function normalizeHostCapabilities(
  capabilities: readonly HostCapability[] | undefined,
): HostCapabilities {
  return [...new Set(capabilities ?? [])].toSorted();
}

export function hasHostCapability(
  capabilities: readonly HostCapability[] | undefined,
  capability: HostCapability,
): boolean {
  return capabilities?.includes(capability) ?? false;
}
