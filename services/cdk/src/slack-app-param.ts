import { Aws, CfnParameter, Fn, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export type SlackAppParam = { arn: string; param: CfnParameter };

/** Declare the optional SecureString name that enables Slack OAuth and signed events. */
export function slackAppParam(stack: Stack): SlackAppParam {
  const param = new CfnParameter(stack, "HarnessSlackAppSsmParam", {
    allowedPattern: "^/.+",
    constraintDescription:
      "must start with / (SSM parameter names are always referenced by full path)",
    default: "/auto-harness/slack-app",
    description:
      "Optional SSM SecureString parameter name holding Slack clientId, clientSecret, and signingSecret JSON.",
    noEcho: true,
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

/** Grant only the public REST handler access to the optional Slack application secret. */
export function grantSlackAppAccess(fn: NodejsFunction, parameter: SlackAppParam): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameter.arn] }),
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      conditions: {
        StringEquals: {
          "kms:EncryptionContext:PARAMETER_ARN": parameter.arn,
          "kms:ViaService": Fn.join("", ["ssm.", Aws.REGION, ".amazonaws.com"]),
        },
      },
      resources: [
        Fn.join("", [
          "arn:",
          Aws.PARTITION,
          ":kms:",
          Aws.REGION,
          ":",
          Aws.ACCOUNT_ID,
          ":alias/aws/ssm",
        ]),
      ],
    }),
  );
}
