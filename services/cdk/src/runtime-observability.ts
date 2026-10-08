import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

import { addErrorAlarm, createAlarmTopic } from "./runtime-alarms.ts";

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

/**
 * RETAINed, not DESTROYed: toggling `accessLogsEnabled` off removes this construct
 * from the synthesized stack, and a DESTROY policy would delete up to 14 days of
 * retained access-log history along with it. RETAIN just orphans the log group
 * instead, matching services/cdk/src/apigateway-account-stack.ts.
 */
function accessLogGroup(scope: Construct, id: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    removalPolicy: RemovalPolicy.RETAIN,
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
  format: string,
  throttle: { burst: number; rate: number },
  logGroup: logs.LogGroup | undefined,
): void {
  if (logGroup) {
    stage.accessLogSettings = { destinationArn: logGroup.logGroupArn, format };
    stage.node.addDependency(logGroup);
  }
  stage.defaultRouteSettings = {
    detailedMetricsEnabled: true,
    throttlingBurstLimit: throttle.burst,
    throttlingRateLimit: throttle.rate,
  };
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

/**
 * Stage throttles and operational CloudWatch alarms, plus redacted access logs when
 * `accessLogsEnabled` is set. Access logs require a one-time, account-level API Gateway
 * CloudWatch Logs role (`scripts/bootstrap-apigateway-account.sh`) that this stack
 * deliberately does not provision — see docs/deploy-aws.md.
 *
 * Creates alarms only when enabled or when emails are configured. Access logs and stage
 * throttles are independent of this opt-in. Returns the shared alarm topic when enabled.
 */
export function addRuntimeObservability(input: {
  scope: Construct;
  environment: string;
  accessLogsEnabled: boolean;
  alarmsEnabled?: boolean;
  alarmEmails?: readonly string[];
  rest: NodejsFunction;
  websocket: NodejsFunction;
  cron: NodejsFunction;
  httpApi: apigatewayv2.CfnApi;
  httpStage: apigatewayv2.CfnStage;
  websocketApi: apigatewayv2.CfnApi;
  websocketStage: apigatewayv2.CfnStage;
}): sns.Topic | undefined {
  configureStage(
    input.httpStage,
    HTTP_ACCESS_LOG_FORMAT,
    HTTP_THROTTLE,
    input.accessLogsEnabled ? accessLogGroup(input.scope, "HttpAccessLogs") : undefined,
  );
  configureStage(
    input.websocketStage,
    WEBSOCKET_ACCESS_LOG_FORMAT,
    WEBSOCKET_THROTTLE,
    input.accessLogsEnabled ? accessLogGroup(input.scope, "WebSocketAccessLogs") : undefined,
  );

  const emails = input.alarmEmails ?? [];
  if (!(input.alarmsEnabled ?? false) && emails.length === 0) return undefined;
  const topic = createAlarmTopic(input.scope, input.environment, emails);
  const errors = { period: Duration.minutes(5), statistic: "Sum" } as const;
  addErrorAlarm(input.scope, "RestFunctionErrors", input.rest.metricErrors(errors), 1, topic);
  addErrorAlarm(
    input.scope,
    "WebSocketFunctionErrors",
    input.websocket.metricErrors(errors),
    1,
    topic,
  );
  addErrorAlarm(input.scope, "CronFunctionErrors", input.cron.metricErrors(errors), 1, topic);
  addErrorAlarm(input.scope, "HttpApi5xx", apiGateway5xx(input.httpApi.ref, "$default"), 1, topic);
  addErrorAlarm(
    input.scope,
    "WebSocketApiErrors",
    websocketApiErrors(input.websocketApi.ref, "prod"),
    1,
    topic,
  );

  const env = input.environment;
  addErrorAlarm(
    input.scope,
    "QueueAge",
    operationalMetric("QueueAgeSeconds", env, "Maximum", cloudwatch.Unit.SECONDS),
    1800,
    topic,
  );
  // A retry is an expected bounded recovery. Alarm only when its one-retry budget is
  // exhausted and the logical session still cannot proceed.
  addErrorAlarm(
    input.scope,
    "InfrastructureRetryExhausted",
    operationalMetric("InfrastructureRetryExhausted", env, "Sum", cloudwatch.Unit.COUNT),
    1,
    topic,
  );
  return topic;
}
