import { ArnFormat, Aws, Fn, Stack } from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

export function addLambdaIntegration(
  scope: Construct,
  id: string,
  api: apigatewayv2.CfnApi,
  handler: lambda.Function,
  payloadFormatVersion?: string,
): apigatewayv2.CfnIntegration {
  const integration = new apigatewayv2.CfnIntegration(scope, `${id}Integration`, {
    apiId: api.ref,
    integrationType: "AWS_PROXY",
    integrationUri: Stack.of(scope).formatArn({
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      resource: "path/2015-03-31/functions",
      resourceName: `${handler.functionArn}/invocations`,
      service: "apigateway",
    }),
    ...(payloadFormatVersion ? { payloadFormatVersion } : {}),
  });
  handler.addPermission(`${id}ApiGatewayInvoke`, {
    principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    sourceArn: Fn.join("", [
      "arn:",
      Aws.PARTITION,
      ":execute-api:",
      Aws.REGION,
      ":",
      Aws.ACCOUNT_ID,
      ":",
      api.ref,
      "/*",
    ]),
  });
  return integration;
}
