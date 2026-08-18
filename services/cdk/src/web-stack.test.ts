import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, it } from "vitest";

import { AutoHarnessWebStack } from "./web-stack.ts";

describe("AutoHarnessWebStack", () => {
  it("hosts Next.js on Lambda behind one CloudFront distribution", () => {
    const app = new App();
    const repositoryStack = new Stack(app, "RepositoryStack");
    const stack = new AutoHarnessWebStack(app, "Web", {
      imageCode: lambda.DockerImageCode.fromEcr(new ecr.Repository(repositoryStack, "Repository")),
      restApiUrl: "https://rest.execute-api.us-west-2.amazonaws.com",
      websocketUrl: "wss://socket.execute-api.us-west-2.amazonaws.com/prod",
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          HARNESS_API_HTTP: "https://rest.execute-api.us-west-2.amazonaws.com",
          HARNESS_AUTH_MODE: "required",
          HARNESS_WEB_REMOTE_AUTH: "1",
        },
      },
      MemorySize: 1024,
      PackageType: "Image",
      Architectures: ["arm64"],
      Timeout: 30,
    });
    template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "AWS_IAM" });
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      InvokedViaFunctionUrl: true,
      Principal: "cloudfront.amazonaws.com",
      SourceArn: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunctionUrl",
      FunctionUrlAuthType: "AWS_IAM",
      Principal: "cloudfront.amazonaws.com",
      SourceArn: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/_next/static/*",
            CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
            OriginRequestPolicyId: Match.absent(),
          }),
          Match.objectLike({
            PathPattern: "/health",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          }),
          Match.objectLike({
            PathPattern: "/api/*",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          }),
          Match.objectLike({
            PathPattern: "/ws*",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          }),
        ]),
        Enabled: true,
      }),
    });
    template.resourceCountIs("AWS::CloudFront::Function", 1);
    template.hasOutput("WebUrl", {});
  });
});
