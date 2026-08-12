import {
  describeControlPlane,
  DYNAMO_TABLES,
  EVENTBRIDGE_CRON,
  S3_ARCHIVE_BUCKET,
  statusShardKey,
} from "./tables.ts";

export { AutoHarnessFoundationStack } from "./foundation-stack.ts";
export type { FoundationResources, FoundationStackProps } from "./foundation-stack.ts";
export { AutoHarnessRuntimeStack } from "./runtime-stack.ts";
export type { RuntimeResources, RuntimeStackProps } from "./runtime-stack.ts";

/** AWS CDK infrastructure service identity. */
export const serviceName = "@auto-harness/cdk" as const;

export function getServiceName(): string {
  return serviceName;
}

export { describeControlPlane, DYNAMO_TABLES, EVENTBRIDGE_CRON, S3_ARCHIVE_BUCKET, statusShardKey };
