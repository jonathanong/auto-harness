import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/agent-web` as const;

export function getServiceName(): string {
  return serviceName;
}
