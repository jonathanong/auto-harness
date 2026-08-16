import { Aws, CfnParameter, Fn, type Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

/**
 * SSM SecureString parameter *names*, not values. CloudFormation cannot create a
 * SecureString via AWS::SSM::Parameter, so the operator populates these out-of-band
 * (`aws ssm put-parameter --type SecureString ...`) before deploy — the stack only needs
 * to know where to look. That is the point: putting the secret's plaintext value
 * directly into a Lambda environment variable, the previous approach, makes it readable
 * in cleartext by anyone with `lambda:GetFunctionConfiguration` and visible in
 * CloudTrail's Lambda-configuration events. A parameter name is not sensitive.
 */
type BootstrapSecretParam = { arn: string; param: CfnParameter };

type BootstrapSecretParams = {
  admins: BootstrapSecretParam;
  cursorSecret: BootstrapSecretParam;
  sessionSecret: BootstrapSecretParam;
};

const DEFINITIONS = [
  {
    key: "admins",
    id: "HarnessAdminsSsmParam",
    description:
      "SSM SecureString parameter name holding base64-encoded HARNESS_ADMINS bootstrap JSON.",
    defaultName: "/auto-harness/harness-admins",
  },
  {
    key: "sessionSecret",
    id: "HarnessSessionSecretSsmParam",
    description:
      "SSM SecureString parameter name holding the control-plane browser session signing secret.",
    defaultName: "/auto-harness/harness-session-secret",
  },
  {
    key: "cursorSecret",
    id: "HarnessCursorSecretSsmParam",
    description:
      "SSM SecureString parameter name holding the stable HMAC secret for paginated session cursors.",
    defaultName: "/auto-harness/harness-cursor-secret",
  },
] as const;

/** Declare all three bootstrap-secret CfnParameters on `stack` at once. */
export function bootstrapSecretParams(stack: Stack): BootstrapSecretParams {
  const byKey = Object.fromEntries(
    DEFINITIONS.map((def) => [def.key, bootstrapSecretParam(stack, def)]),
  );
  return byKey as BootstrapSecretParams;
}

function bootstrapSecretParam(
  stack: Stack,
  definition: { id: string; description: string; defaultName: string },
): BootstrapSecretParam {
  const param = new CfnParameter(stack, definition.id, {
    default: definition.defaultName,
    description: definition.description,
    // The value is a parameter *name*, not a secret — noEcho here is defense-in-depth
    // against a future default being confused for the secret itself, and it silences
    // CloudFormation's "appears to be a password" heuristic on parameter ids containing
    // "Secret".
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

/**
 * Grant a Lambda function read access to the three bootstrap-secret SSM parameters.
 * The AWS-managed key (alias/aws/ssm) encrypts a SecureString parameter unless the
 * operator names a customer-managed key at put-parameter time; its default resource
 * policy already grants decrypt through IAM, so no key-policy edit is needed here.
 */
export function grantBootstrapSecretsAccess(
  fn: NodejsFunction,
  params: BootstrapSecretParams,
): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [params.admins.arn, params.sessionSecret.arn, params.cursorSecret.arn],
    }),
  );
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
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
