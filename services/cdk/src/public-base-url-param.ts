import { Aws, CfnParameter, Fn, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

/**
 * SSM `String` parameter *name*, not value — mirrors bootstrap-secret-param.ts, but for a
 * plain, non-secret value: the CloudFront URL this environment answers on. Unlike the
 * three bootstrap secrets, this value cannot exist before the stack deploys — it is the
 * Web stack's own CloudFront distribution domain, and Web depends on Runtime (not the
 * reverse: see runtime-stack.ts / web-stack.ts), so Runtime cannot reference it at synth
 * time even on a first deploy. The lifecycle script (deployment-support.ts smokeDeployment)
 * writes the resolved WebUrl into this parameter once the Web stack is up and its health
 * check passes; Runtime's Lambdas only need to know the parameter's *name* ahead of time,
 * and read the value at cold start (services/api/src/lambda-handlers.ts
 * fetchPublicBaseUrl), gracefully falling back to ControlPlane's own
 * http://localhost:7421 default if it is missing — this is a display URL used for a
 * session's `url` field and the Slack integration's deep link, never a security boundary,
 * so a missing value degrades gracefully instead of failing a Lambda cold start closed.
 */
type PublicBaseUrlParam = { arn: string; param: CfnParameter };

export function publicBaseUrlParam(stack: Stack): PublicBaseUrlParam {
  const param = new CfnParameter(stack, "HarnessPublicBaseUrlSsmParam", {
    default: "/auto-harness/public-base-url",
    description:
      "SSM String parameter name holding the CloudFront URL this environment answers on. Written by the deploy lifecycle script after the Web stack deploys — not set before then.",
    // Same reasoning as bootstrap-secret-param.ts: an SSM parameter ARN needs exactly one
    // "/" between "parameter" and the name, which only a hierarchical name's own leading
    // slash supplies. A flat-name override would silently build a wrong ARN that
    // ssm:GetParameter never matches.
    allowedPattern: "^/.+",
    constraintDescription:
      "must start with / (SSM parameter names are always referenced by full path)",
    type: "String",
  });
  const arn = Fn.join("", [
    "arn:",
    Aws.PARTITION,
    ":ssm:",
    Aws.REGION,
    ":",
    Aws.ACCOUNT_ID,
    ":parameter",
    param.valueAsString,
  ]);
  return { arn, param };
}

/**
 * Grant a Lambda function read access to the public-base-url SSM parameter. Unlike the
 * bootstrap secrets, this is a plain `String` parameter — SSM does not encrypt it, so no
 * KMS decrypt grant is needed alongside `ssm:GetParameter`.
 */
export function grantPublicBaseUrlAccess(fn: NodejsFunction, param: PublicBaseUrlParam): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [param.arn],
    }),
  );
}
