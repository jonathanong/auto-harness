import { CfnOutput, Duration, Fn, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export type WebStackProps = StackProps & {
  imageCode: lambda.DockerImageCode;
  restApiUrl: string;
  websocketUrl: string;
};

/** Serverless browser UI: CloudFront routes Next.js, HTTP API, and WebSocket traffic. */
export class AutoHarnessWebStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly webFunction: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const webFunction = new lambda.DockerImageFunction(this, "WebFunction", {
      architecture: lambda.Architecture.ARM_64,
      code: props.imageCode,
      environment: {
        HARNESS_API_HTTP: props.restApiUrl,
        HARNESS_AUTH_MODE: "required",
        HARNESS_WEB_REMOTE_AUTH: "1",
      },
      logRetention: RetentionDays.TWO_WEEKS,
      memorySize: 1024,
      timeout: Duration.seconds(30),
    });
    const functionUrl = webFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });
    const apiDomain = Fn.select(2, Fn.split("/", props.restApiUrl));
    const websocketDomain = Fn.select(2, Fn.split("/", props.websocketUrl));
    const websocketRewrite = new cloudfront.Function(this, "WebSocketPathRewrite", {
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { event.request.uri = '/'; return event.request; }",
      ),
    });
    const webOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl);
    const uncached = {
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    } satisfies Omit<cloudfront.BehaviorOptions, "origin">;
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        ...uncached,
        origin: webOrigin,
      },
      additionalBehaviors: {
        "/_next/static/*": {
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          origin: webOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        "/health": {
          ...uncached,
          origin: new origins.HttpOrigin(apiDomain),
        },
        "/api/*": {
          ...uncached,
          origin: new origins.HttpOrigin(apiDomain),
        },
        "/ws*": {
          ...uncached,
          functionAssociations: [
            {
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              function: websocketRewrite,
            },
          ],
          origin: new origins.HttpOrigin(websocketDomain, { originPath: "/prod" }),
        },
      },
    });
    webFunction.addPermission("CloudFrontInvokeFunction", {
      action: "lambda:InvokeFunction",
      invokedViaFunctionUrl: true,
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      sourceArn: distribution.distributionArn,
    });
    webFunction.addPermission("CloudFrontInvokeFunctionUrl", {
      action: "lambda:InvokeFunctionUrl",
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      sourceArn: distribution.distributionArn,
    });

    void new CfnOutput(this, "WebUrl", {
      value: Fn.join("", ["https://", distribution.distributionDomainName]),
    });
    this.distribution = distribution;
    this.webFunction = webFunction;
  }
}
