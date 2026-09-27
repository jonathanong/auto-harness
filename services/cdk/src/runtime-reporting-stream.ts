import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { Construct } from "constructs";

export function addSessionReportingStream(
  scope: Construct,
  cron: lambda.Function,
  sessions: Pick<dynamodb.Table, "tableArn" | "tableStreamArn">,
): void {
  cron.addEnvironment("HARNESS_SESSION_STREAM_ARN", sessions.tableStreamArn!);
  const reportingStreamTable = dynamodb.Table.fromTableAttributes(scope, "ReportingSessionStream", {
    tableArn: sessions.tableArn,
    tableStreamArn: sessions.tableStreamArn!,
  });
  cron.addEventSource(
    new DynamoEventSource(reportingStreamTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 25,
      reportBatchItemFailures: true,
      bisectBatchOnError: true,
      retryAttempts: -1,
    }),
  );
}
