import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/** Keep in sync with services/api/src/operational-metrics.ts. */
const OPERATIONAL_METRIC_NAMESPACE = "AutoHarness";

export const HTTP_THROTTLE = { burst: 200, rate: 100 } as const;
export const WEBSOCKET_THROTTLE = { burst: 500, rate: 250 } as const;

const HTTP_ACCESS_LOG_FORMAT = JSON.stringify({
  errorMessage: "$context.error.message",
  httpMethod: "$context.httpMethod",
  integrationErrorMessage: "$context.integrationErrorMessage",
  integrationStatus: "$context.integrationStatus",
  ip: "$context.identity.sourceIp",
  protocol: "$context.protocol",
  requestId: "$context.requestId",
  requestTime: "$context.requestTime",
  responseLength: "$context.responseLength",
  routeKey: "$context.routeKey",
  status: "$context.status",
});

const WEBSOCKET_ACCESS_LOG_FORMAT = JSON.stringify({
  connectionId: "$context.connectionId",
  eventType: "$context.eventType",
  integrationErrorMessage: "$context.integrationErrorMessage",
  ip: "$context.identity.sourceIp",
  requestId: "$context.requestId",
  requestTime: "$context.requestTime",
  routeKey: "$context.routeKey",
  status: "$context.status",
});

function accessLogGroup(scope: Construct, id: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    removalPolicy: RemovalPolicy.DESTROY,
    retention: logs.RetentionDays.TWO_WEEKS,
  });
  logGroup.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      principals: [new iam.ServicePrincipal("apigateway.amazonaws.com")],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
    }),
  );
  return logGroup;
}

function configureStage(
  stage: apigatewayv2.CfnStage,
  logGroup: logs.LogGroup,
  format: string,
  throttle: { burst: number; rate: number },
): void {
  stage.accessLogSettings = { destinationArn: logGroup.logGroupArn, format };
  stage.defaultRouteSettings = {
    detailedMetricsEnabled: true,
    throttlingBurstLimit: throttle.burst,
    throttlingRateLimit: throttle.rate,
  };
  stage.node.addDependency(logGroup);
}

function addErrorAlarm(
  scope: Construct,
  id: string,
  metric: cloudwatch.IMetric,
  threshold: number,
): cloudwatch.Alarm {
  return new cloudwatch.Alarm(scope, id, {
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric,
    threshold,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}

function apiGateway5xx(apiId: string, stage: string): cloudwatch.Metric {
  return new cloudwatch.Metric({
    dimensionsMap: { ApiId: apiId, Stage: stage },
    metricName: "5xx",
    namespace: "AWS/ApiGateway",
    period: Duration.minutes(5),
    statistic: "Sum",
  });
}

function websocketApiErrors(apiId: string, stage: string): cloudwatch.MathExpression {
  const dimensionsMap = { ApiId: apiId, Stage: stage };
  return new cloudwatch.MathExpression({
    expression: "integration + execution",
    usingMetrics: {
      integration: new cloudwatch.Metric({
        dimensionsMap,
        metricName: "IntegrationError",
        namespace: "AWS/ApiGateway",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      execution: new cloudwatch.Metric({
        dimensionsMap,
        metricName: "ExecutionError",
        namespace: "AWS/ApiGateway",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
    },
    period: Duration.minutes(5),
    label: "WebSocket integration and execution errors",
  });
}

function operationalMetric(
  name: string,
  environment: string,
  statistic: string,
  unit: cloudwatch.Unit,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    dimensionsMap: { Environment: environment },
    metricName: name,
    namespace: OPERATIONAL_METRIC_NAMESPACE,
    period: Duration.minutes(5),
    statistic,
    unit,
  });
}

/** Redacted access logs, stage throttles, and operational CloudWatch alarms. */
export function addRuntimeObservability(input: {
  scope: Construct;
  environment: string;
  rest: NodejsFunction;
  websocket: NodejsFunction;
  cron: NodejsFunction;
  httpApi: apigatewayv2.CfnApi;
  httpStage: apigatewayv2.CfnStage;
  websocketApi: apigatewayv2.CfnApi;
  websocketStage: apigatewayv2.CfnStage;
}): void {
  configureStage(
    input.httpStage,
    accessLogGroup(input.scope, "HttpAccessLogs"),
    HTTP_ACCESS_LOG_FORMAT,
    HTTP_THROTTLE,
  );
  configureStage(
    input.websocketStage,
    accessLogGroup(input.scope, "WebSocketAccessLogs"),
    WEBSOCKET_ACCESS_LOG_FORMAT,
    WEBSOCKET_THROTTLE,
  );

  const errors = { period: Duration.minutes(5), statistic: "Sum" } as const;
  addErrorAlarm(input.scope, "RestFunctionErrors", input.rest.metricErrors(errors), 1);
  addErrorAlarm(input.scope, "WebSocketFunctionErrors", input.websocket.metricErrors(errors), 1);
  addErrorAlarm(input.scope, "CronFunctionErrors", input.cron.metricErrors(errors), 1);
  addErrorAlarm(input.scope, "HttpApi5xx", apiGateway5xx(input.httpApi.ref, "$default"), 1);
  addErrorAlarm(
    input.scope,
    "WebSocketApiErrors",
    websocketApiErrors(input.websocketApi.ref, "prod"),
    1,
  );

  const env = input.environment;
  addErrorAlarm(
    input.scope,
    "QueueAge",
    operationalMetric("QueueAgeSeconds", env, "Maximum", cloudwatch.Unit.SECONDS),
    1800,
  );
  for (const name of [
    "AssignmentFailures",
    "AckTimeouts",
    "StaleHosts",
    "Cooldowns",
    "LogDrops",
  ] as const) {
    addErrorAlarm(input.scope, name, operationalMetric(name, env, "Sum", cloudwatch.Unit.COUNT), 1);
  }
}
