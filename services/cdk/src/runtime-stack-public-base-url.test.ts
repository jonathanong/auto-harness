import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

/**
 * Unlike the three bootstrap secrets, the public-base-url value cannot be known at synth
 * time — Web depends on Runtime, not the reverse, so CloudFront's domain doesn't exist
 * yet. Every Lambda still needs the parameter's *name* up front; the deploy lifecycle
 * script writes the actual WebUrl into it only after Web deploys (see
 * deployment-support.ts smokeDeployment). See public-base-url-param.ts.
 */
describe("AutoHarnessRuntimeStack public-base-url wiring", () => {
  it("gives every Lambda the parameter name and a scoped, KMS-free read grant", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);

    const functions = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (fn) => fn.Properties?.Environment?.Variables?.PUBLIC_BASE_URL_SSM_PARAM,
    );
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn.Properties?.Environment?.Variables?.PUBLIC_BASE_URL_SSM_PARAM).toEqual({
        Ref: "HarnessPublicBaseUrlSsmParam",
      });
    }

    // The public-base-url parameter gets its own ssm:GetParameter grant, scoped to just
    // that one parameter — unlike the bootstrap secrets, it is a plain String value, so no
    // kms:Decrypt grant accompanies it.
    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "ssm:GetParameter",
              Effect: "Allow",
              Resource: Match.objectLike({
                "Fn::Join": Match.arrayWith([
                  Match.arrayWith([Match.objectLike({ Ref: "HarnessPublicBaseUrlSsmParam" })]),
                ]),
              }),
            }),
          ]),
        },
      },
      3,
    );
  });
});
