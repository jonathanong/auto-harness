import { RemovalPolicy } from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/**
 * RETAINed, not DESTROYed, matching runtime-observability.ts's accessLogGroup: deleting or
 * renaming a Lambda function's construct would otherwise delete up to 14 days of retained
 * application log history along with the orphaned log group.
 */
export function functionLogGroup(scope: Construct, id: string): logs.LogGroup {
  return new logs.LogGroup(scope, `${id}LogGroup`, {
    removalPolicy: RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.TWO_WEEKS,
  });
}
