import { PACKAGE_SCOPE } from "@auto-harness/shared";

import {
  describeControlPlane,
  DYNAMO_TABLES,
  EVENTBRIDGE_CRON,
  S3_ARCHIVE_BUCKET,
  statusShardKey,
} from "./tables.js";

/** AWS CDK infrastructure service identity. */
export const serviceName = `${PACKAGE_SCOPE}/cdk` as const;

export function getServiceName(): string {
  return serviceName;
}

export { describeControlPlane, DYNAMO_TABLES, EVENTBRIDGE_CRON, S3_ARCHIVE_BUCKET, statusShardKey };
