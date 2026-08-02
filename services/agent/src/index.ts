import { PACKAGE_SCOPE } from "@auto-harness/shared";

/** VPS agent service identity (session runner lands here). */
export const serviceName = `${PACKAGE_SCOPE}/agent` as const;

export function getServiceName(): string {
  return serviceName;
}
