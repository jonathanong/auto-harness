import { describeControlPlane, DYNAMO_TABLES, statusShardKey } from "./tables.ts";

/** AWS CDK infrastructure service identity. */
const serviceName = "@auto-harness/cdk" as const;

export function getServiceName(): string {
  return serviceName;
}

export { describeControlPlane, DYNAMO_TABLES, statusShardKey };
