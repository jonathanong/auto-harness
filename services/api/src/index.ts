import { PACKAGE_SCOPE } from "@auto-harness/shared";

/** Control-plane API service identity (REST + WebSocket handlers land here). */
export const serviceName = `${PACKAGE_SCOPE}/api` as const;

export function getServiceName(): string {
  return serviceName;
}
