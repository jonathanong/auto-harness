import type { SecretValue } from "aws-cdk-lib";
import type * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import type * as events from "aws-cdk-lib/aws-events";
import type * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";

export type RuntimeResources = {
  cloudFrontIngressSecret: SecretValue;
  cronFunction: nodejs.NodejsFunction;
  cronRule: events.Rule;
  httpApi: apigatewayv2.CfnApi;
  restFunction: nodejs.NodejsFunction;
  restApiUrl: string;
  websocketApi: apigatewayv2.CfnApi;
  websocketFunction: nodejs.NodejsFunction;
  websocketUrl: string;
};
