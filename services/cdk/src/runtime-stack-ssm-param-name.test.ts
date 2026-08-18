import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

/**
 * An SSM parameter ARN needs exactly one "/" between "parameter" and the name: a
 * hierarchical name's own leading slash supplies it, a flat name has none. The ARN
 * built in bootstrap-secret-param.ts relies on the name supplying it, so accepting a
 * flat-name override would silently construct the wrong ARN (":parameterharness-admins"
 * instead of ":parameter/harness-admins") — one that ssm:GetParameter never matches,
 * failing every Lambda cold start closed. AllowedPattern is CloudFormation's own
 * deploy-time guard against exactly that: a bad override is rejected before the stack
 * ever reaches the ARN-construction code, not silently accepted and gotten wrong.
 */
describe("bootstrap-secret SSM parameter name validation", () => {
  it("rejects a non-slash-prefixed override for every bootstrap-secret SSM parameter name", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
      tablePrefix: "ReviewRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
      foundation: foundation.resources,
      tablePrefix: "ReviewRuntime",
    });
    const template = Template.fromStack(runtime);
    const parameters = template.toJSON().Parameters as Record<
      string,
      { AllowedPattern?: string; Default?: string }
    >;

    // Same guard applies to the public-base-url parameter (public-base-url-param.ts) even
    // though it isn't a bootstrap secret — it shares the exact ARN-construction hazard.
    for (const id of [
      "HarnessAdminsSsmParam",
      "HarnessSessionSecretSsmParam",
      "HarnessCursorSecretSsmParam",
      "HarnessPublicBaseUrlSsmParam",
    ]) {
      const pattern = parameters[id]?.AllowedPattern;
      expect(pattern).toBeDefined();
      const regex = new RegExp(pattern!);
      // The exact override the review found broken: no leading slash.
      expect(regex.test("harness-admins")).toBe(false);
      // A hierarchical override, and the shipped default, both still work.
      expect(regex.test("/harness-admins")).toBe(true);
      expect(regex.test(parameters[id]!.Default!)).toBe(true);
    }
  });
});
