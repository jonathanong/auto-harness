import { PACKAGE_SCOPE } from "@auto-harness/shared";

/** Web UI service identity. */
export const serviceName = `${PACKAGE_SCOPE}/web` as const;

export function getServiceName(): string {
  return serviceName;
}
