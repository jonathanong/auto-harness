import { Aws, CfnParameter, Fn, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export type BlackboardParam = { arn: string; param: CfnParameter };

/** Declare the SecureString name for mandatory autonomous reporting. */
export function blackboardParam(stack: Stack): BlackboardParam {
  const param = new CfnParameter(stack, "HarnessBlackboardSsmParam", {
    allowedPattern: "^/.+",
    constraintDescription:
      "must start with / (SSM parameter names are always referenced by full path)",
    default: "/auto-harness/blackboard-reporting",
    description:
      "SSM SecureString parameter name holding required Blackboard reporting URL, dedicated writer token, and trusted repository/principal policy JSON.",
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

/** Grant trusted control-plane functions access to the reporting configuration. */
export function grantBlackboardAccess(fn: NodejsFunction, parameter: BlackboardParam): void {
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
