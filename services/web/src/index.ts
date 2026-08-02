import { PACKAGE_SCOPE } from "@auto-harness/shared";

/** Web UI service identity (Next.js app lands here). */
export const serviceName = `${PACKAGE_SCOPE}/web` as const;

export function getServiceName(): string {
  return serviceName;
}
