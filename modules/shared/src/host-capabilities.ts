import {
  DEFAULT_MAX_CONCURRENT_ASSIGNMENTS,
  MAX_CONCURRENT_ASSIGNMENTS_LIMIT,
} from "./constants.ts";

/** Explicit feature support advertised by a connected host daemon. */
export const HOST_CAPABILITIES = ["scheduled-main-checkout"] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

/**
 * Capability arrays are deliberately additive: an omitted field from an older
 * daemon means it supports no optional features.
 */
export type HostCapabilities = HostCapability[];

/** Modern daemons nest assignment capacity under the capabilities advertisement. */
export type HostCapabilitiesAdvertisement = {
  features: HostCapabilities;
  maxConcurrentAssignments?: number;
};

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

function isPositiveAssignmentCap(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CONCURRENT_ASSIGNMENTS_LIMIT
  );
}

/**
 * Accept a legacy feature array or a `{ features, maxConcurrentAssignments }`
 * object. Unknown keys and invalid caps fail closed.
 */
export function parseHostCapabilitiesAdvertisement(
  value: unknown,
): HostCapabilitiesAdvertisement | null {
  if (value === undefined) return { features: [] };
  if (Array.isArray(value)) {
    if (
      value.length > HOST_CAPABILITIES.length ||
      !value.every(isHostCapability) ||
      new Set(value).size !== value.length
    ) {
      return null;
    }
    return { features: normalizeHostCapabilities(value) };
  }
  if (!value || typeof value !== "object") return null;
  const advertised = value as Record<string, unknown>;
  const keys = Object.keys(advertised);
  if (keys.some((key) => key !== "features" && key !== "maxConcurrentAssignments")) return null;
  let features: HostCapabilities = [];
  if (advertised.features !== undefined) {
    if (
      !Array.isArray(advertised.features) ||
      advertised.features.length > HOST_CAPABILITIES.length ||
      !advertised.features.every(isHostCapability) ||
      new Set(advertised.features).size !== advertised.features.length
    ) {
      return null;
    }
    features = normalizeHostCapabilities(advertised.features);
  }
  if (advertised.maxConcurrentAssignments === undefined) {
    return { features, maxConcurrentAssignments: DEFAULT_MAX_CONCURRENT_ASSIGNMENTS };
  }
  if (!isPositiveAssignmentCap(advertised.maxConcurrentAssignments)) return null;
  return { features, maxConcurrentAssignments: advertised.maxConcurrentAssignments };
}

export function defaultMaxConcurrentAssignments(advertised: number | undefined): number {
  return advertised ?? DEFAULT_MAX_CONCURRENT_ASSIGNMENTS;
}
