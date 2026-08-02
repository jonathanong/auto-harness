import { PACKAGE_SCOPE } from "@auto-harness/shared";

/** AWS CDK infrastructure service identity. */
export const serviceName = `${PACKAGE_SCOPE}/cdk` as const;

export function getServiceName(): string {
  return serviceName;
}
