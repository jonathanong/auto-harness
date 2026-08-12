import { fileURLToPath } from "node:url";

import { Aws, CfnOutput, CfnParameter, Duration, Fn, Stack, type StackProps } from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

import type { FoundationResources } from "./foundation-stack.ts";
import { addLambdaIntegration } from "./runtime-api-integration.ts";

export type RuntimeStackProps = StackProps & {
  foundation: FoundationResources;
  tablePrefix: string;
};

export type RuntimeResources = {
  httpApi: apigatewayv2.CfnApi;
  integrationKey: kms.Key;
  restFunction: nodejs.NodejsFunction;
  websocketApi: apigatewayv2.CfnApi;
  websocketFunction: nodejs.NodejsFunction;
};

const lambdaEntry = fileURLToPath(new URL("../../api/src/lambda-handlers.ts", import.meta.url));

/** Synthesizable REST + WebSocket Lambda runtime. This construct never deploys by itself. */
export class AutoHarnessRuntimeStack extends Stack {
  readonly resources: RuntimeResources;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const admins = new CfnParameter(this, "HarnessAdmins", {
      description: "Base64-encoded HARNESS_ADMINS bootstrap JSON.",
      noEcho: true,
      type: "String",
    });
    const sessionSecret = new CfnParameter(this, "HarnessSessionSecret", {
      description: "Signing secret for control-plane browser sessions.",
      minLength: 32,
      noEcho: true,
      type: "String",
    });
    const webOrigin = new CfnParameter(this, "WebOrigin", {
      description: "Exact browser origin allowed by control-plane CORS.",
      type: "String",
    });
    const integrationKey = new kms.Key(this, "IntegrationKey", {
      description: "Encrypts Auto Harness integration credentials.",
      enableKeyRotation: true,
    });

    const commonEnvironment = {
      HARNESS_ADMINS: admins.valueAsString,
      HARNESS_DDB_PREFIX: props.tablePrefix,
      HARNESS_SESSION_SECRET: sessionSecret.valueAsString,
      KMS_KEY_ID: integrationKey.keyArn,
      WEB_ORIGIN: webOrigin.valueAsString,
    };
    const functionProps = {
      bundling: { minify: true, sourceMap: true },
      entry: lambdaEntry,
      environment: commonEnvironment,
      memorySize: 256,
      runtime: lambda.Runtime.NODEJS_22_X,
    } satisfies Partial<nodejs.NodejsFunctionProps>;
    const restFunction = new nodejs.NodejsFunction(this, "RestFunction", {
      ...functionProps,
      handler: "rest",
      timeout: Duration.seconds(15),
    });
    const websocketFunction = new nodejs.NodejsFunction(this, "WebSocketFunction", {
      ...functionProps,
      handler: "websocket",
      timeout: Duration.seconds(30),
    });
    const apiDataAccessPolicy = iam.ManagedPolicy.fromManagedPolicyArn(
      this,
      "ImportedApiDataAccessPolicy",
      props.foundation.apiDataAccessPolicy.managedPolicyArn,
    );
    restFunction.role!.addManagedPolicy(apiDataAccessPolicy);
    websocketFunction.role!.addManagedPolicy(apiDataAccessPolicy);
    integrationKey.grantEncryptDecrypt(restFunction);
    integrationKey.grantEncryptDecrypt(websocketFunction);

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
    websocketFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [
          Fn.join("", [
            "arn:",
            Aws.PARTITION,
            ":execute-api:",
            Aws.REGION,
            ":",
            Aws.ACCOUNT_ID,
            ":",
            websocketApi.ref,
            "/prod/POST/@connections/*",
          ]),
        ],
      }),
    );

    const restApiUrl = new CfnOutput(this, "RestApiUrl", { value: httpApi.attrApiEndpoint });
    const websocketUrl = new CfnOutput(this, "WebSocketUrl", {
      value: Fn.join("", [websocketApi.attrApiEndpoint, "/prod"]),
    });
    const integrationKeyArn = new CfnOutput(this, "IntegrationKeyArn", {
      value: integrationKey.keyArn,
    });
    void restApiUrl;
    void websocketUrl;
    void integrationKeyArn;

    this.resources = {
      httpApi,
      integrationKey,
      restFunction,
      websocketApi,
      websocketFunction,
    };
  }
}
