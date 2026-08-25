import { fileURLToPath } from "node:url";

import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

import { bootstrapSecretParams, grantBootstrapSecretsAccess } from "./bootstrap-secret-param.ts";
import type { FoundationResources } from "./foundation-stack.ts";
import { grantRuntimeLambdaAccess } from "./lambda-iam.ts";
import { grantPublicBaseUrlAccess, publicBaseUrlParam } from "./public-base-url-param.ts";
import { addLambdaIntegration } from "./runtime-api-integration.ts";
import { addRuntimeObservability } from "./runtime-observability.ts";

type RuntimeStackProps = StackProps & {
  foundation: FoundationResources;
  tablePrefix: string;
  /** Defaults to false — see addRuntimeObservability's account-role prerequisite. */
  accessLogsEnabled?: boolean;
};

type RuntimeResources = {
  cronFunction: nodejs.NodejsFunction;
  cronRule: events.Rule;
  httpApi: apigatewayv2.CfnApi;
  restFunction: nodejs.NodejsFunction;
  websocketApi: apigatewayv2.CfnApi;
  websocketFunction: nodejs.NodejsFunction;
  restApiUrl: string;
  websocketUrl: string;
};

const lambdaEntry = fileURLToPath(new URL("../../api/src/lambda-handlers.ts", import.meta.url));

/**
 * RETAINed, not DESTROYed, matching runtime-observability.ts's accessLogGroup: deleting or
 * renaming a Lambda function's construct would otherwise delete up to 14 days of retained
 * application log history along with the orphaned log group.
 */
function functionLogGroup(scope: Construct, id: string): logs.LogGroup {
  return new logs.LogGroup(scope, `${id}LogGroup`, {
    removalPolicy: RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.TWO_WEEKS,
  });
}

/** Synthesizable REST + WebSocket Lambda runtime. This construct never deploys by itself. */
export class AutoHarnessRuntimeStack extends Stack {
  readonly resources: RuntimeResources;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const { admins, cursorSecret, sessionSecret } = bootstrapSecretParams(this);
    const publicBaseUrl = publicBaseUrlParam(this);
    const commonEnvironment = {
      HARNESS_ADMINS_SSM_PARAM: admins.param.valueAsString,
      HARNESS_CURSOR_SECRET_SSM_PARAM: cursorSecret.param.valueAsString,
      HARNESS_DDB_PREFIX: props.tablePrefix,
      HARNESS_METRIC_ENVIRONMENT: props.tablePrefix,
      HARNESS_SESSION_SECRET_SSM_PARAM: sessionSecret.param.valueAsString,
      PUBLIC_BASE_URL_SSM_PARAM: publicBaseUrl.param.valueAsString,
    };
    const archiveAndKms = {
      ARCHIVE_BUCKET: props.foundation.archiveBucket.bucketName,
      KMS_KEY_ID: props.foundation.integrationKey.keyArn,
    };
    const functionProps = {
      bundling: { minify: true, sourceMap: true },
      entry: lambdaEntry,
      memorySize: 256,
      runtime: lambda.Runtime.NODEJS_22_X,
    } satisfies Partial<nodejs.NodejsFunctionProps>;
    const restFunction = new nodejs.NodejsFunction(this, "RestFunction", {
      ...functionProps,
      environment: { ...commonEnvironment, ...archiveAndKms },
      handler: "rest",
      logGroup: functionLogGroup(this, "RestFunction"),
      timeout: Duration.seconds(15),
    });
    const websocketFunction = new nodejs.NodejsFunction(this, "WebSocketFunction", {
      ...functionProps,
      environment: commonEnvironment,
      handler: "websocket",
      logGroup: functionLogGroup(this, "WebSocketFunction"),
      timeout: Duration.seconds(30),
    });
    // Minute scheduler also drains the Slack lifecycle outbox through chat.postMessage / chat.update.
    const cronFunction = new nodejs.NodejsFunction(this, "CronFunction", {
      ...functionProps,
      environment: { ...commonEnvironment, ...archiveAndKms },
      handler: "cron",
      logGroup: functionLogGroup(this, "CronFunction"),
      timeout: Duration.seconds(60),
    });
    for (const fn of [restFunction, websocketFunction, cronFunction]) {
      grantBootstrapSecretsAccess(fn, { admins, cursorSecret, sessionSecret });
      grantPublicBaseUrlAccess(fn, publicBaseUrl);
    }

    const httpApi = new apigatewayv2.CfnApi(this, "HttpApi", {
      name: `${this.stackName}-http`,
      protocolType: "HTTP",
    });
    const restIntegration = addLambdaIntegration(this, "Rest", httpApi, restFunction, "2.0");
    const restRoute = new apigatewayv2.CfnRoute(this, "RestDefaultRoute", {
      apiId: httpApi.ref,
      authorizationType: "NONE",
      routeKey: "$default",
      target: Fn.join("/", ["integrations", restIntegration.ref]),
    });
    const httpStage = new apigatewayv2.CfnStage(this, "HttpDefaultStage", {
      apiId: httpApi.ref,
      autoDeploy: true,
      stageName: "$default",
    });
    httpStage.addResourceDependency(restRoute);

    const websocketApi = new apigatewayv2.CfnApi(this, "WebSocketApi", {
      name: `${this.stackName}-websocket`,
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.type",
    });
    const websocketIntegration = addLambdaIntegration(
      this,
      "WebSocket",
      websocketApi,
      websocketFunction,
    );
    const websocketRoutes = ["$connect", "$disconnect", "$default"].map(
      (routeKey) =>
        new apigatewayv2.CfnRoute(this, `WebSocket${routeKey.slice(1)}Route`, {
          apiId: websocketApi.ref,
          authorizationType: "NONE",
          routeKey,
          target: Fn.join("/", ["integrations", websocketIntegration.ref]),
        }),
    );
    const websocketStage = new apigatewayv2.CfnStage(this, "WebSocketStage", {
      apiId: websocketApi.ref,
      autoDeploy: true,
      stageName: "prod",
    });
    for (const route of websocketRoutes) websocketStage.addResourceDependency(route);
    const websocketManagementEndpoint = Fn.join("", [
      "https://",
      websocketApi.ref,
      ".execute-api.",
      Aws.REGION,
      ".",
      Aws.URL_SUFFIX,
      "/prod",
    ]);
    websocketFunction.addEnvironment("WS_API_ENDPOINT", websocketManagementEndpoint);
    restFunction.addEnvironment("WS_API_ENDPOINT", websocketManagementEndpoint);
    cronFunction.addEnvironment("WS_API_ENDPOINT", websocketManagementEndpoint);
    grantRuntimeLambdaAccess({
      rest: restFunction,
      websocket: websocketFunction,
      cron: cronFunction,
      foundation: props.foundation,
      websocketApiId: websocketApi.ref,
    });
    addRuntimeObservability({
      scope: this,
      environment: props.tablePrefix,
      accessLogsEnabled: props.accessLogsEnabled ?? false,
      rest: restFunction,
      websocket: websocketFunction,
      cron: cronFunction,
      httpApi,
      httpStage,
      websocketApi,
      websocketStage,
    });

    const cronRule = new events.Rule(this, "CronRule", {
      description: "Runs durable Auto Harness scheduling and recovery once per minute.",
      schedule: events.Schedule.rate(Duration.minutes(1)),
    });
    cronRule.addTarget(new targets.LambdaFunction(cronFunction));

    const restApiUrl = httpApi.attrApiEndpoint;
    const websocketUrl = Fn.join("", [websocketApi.attrApiEndpoint, "/prod"]);
    void new CfnOutput(this, "RestApiUrl", { value: restApiUrl });
    void new CfnOutput(this, "WebSocketUrl", {
      value: websocketUrl,
    });
    void new CfnOutput(this, "IntegrationKeyArn", {
      value: props.foundation.integrationKey.keyArn,
    });

    this.resources = {
      cronFunction,
      cronRule,
      httpApi,
      restFunction,
      restApiUrl,
      websocketApi,
      websocketFunction,
      websocketUrl,
    };
  }
}
