import { ArnFormat, Aws, Duration, Fn, Stack } from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type * as logs from "aws-cdk-lib/aws-logs";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

/** Adds the private CloudFront-origin credential check before the REST Lambda. */
export function addRuntimeIngressAuthorizer(input: {
  scope: Construct;
  api: apigatewayv2.CfnApi;
  ingressSecret: secretsmanager.Secret;
  functionLogGroup: logs.LogGroup;
  functionProps: Pick<nodejs.NodejsFunctionProps, "bundling" | "entry" | "memorySize" | "runtime">;
}): apigatewayv2.CfnAuthorizer {
  const authorizerFunction = new nodejs.NodejsFunction(input.scope, "IngressAuthorizerFunction", {
    ...input.functionProps,
    environment: { HARNESS_CLOUDFRONT_INGRESS_SECRET_ARN: input.ingressSecret.secretArn },
    handler: "ingressAuthorizer",
    logGroup: input.functionLogGroup,
    timeout: Duration.seconds(5),
  });
  input.ingressSecret.grantRead(authorizerFunction);
  const authorizer = new apigatewayv2.CfnAuthorizer(input.scope, "IngressAuthorizer", {
    apiId: input.api.ref,
    authorizerPayloadFormatVersion: "2.0",
    authorizerResultTtlInSeconds: 0,
    authorizerType: "REQUEST",
    authorizerUri: Stack.of(input.scope).formatArn({
      account: "lambda",
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      resource: "path/2015-03-31/functions",
      resourceName: `${authorizerFunction.functionArn}/invocations`,
      service: "apigateway",
    }),
    enableSimpleResponses: true,
    identitySource: ["$request.header.X-Auto-Harness-Ingress-Token"],
    name: `${Stack.of(input.scope).stackName}-cloudfront-ingress`,
  });
  authorizerFunction.addPermission("HttpApiIngressAuthorizerInvoke", {
    principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    sourceArn: Fn.join("", [
      "arn:",
      Aws.PARTITION,
      ":execute-api:",
      Aws.REGION,
      ":",
      Aws.ACCOUNT_ID,
      ":",
      input.api.ref,
      "/*",
    ]),
  });
  return authorizer;
}
