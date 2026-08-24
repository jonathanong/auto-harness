import { Aws, Fn } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

import type { FoundationResources } from "./foundation-stack.ts";

function manageConnectionsStatement(websocketApiId: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: ["execute-api:ManageConnections"],
    resources: [
      Fn.join("", [
        "arn:",
        Aws.PARTITION,
        ":execute-api:",
        Aws.REGION,
        ":",
        Aws.ACCOUNT_ID,
        ":",
        websocketApiId,
        "/prod/POST/@connections/*",
      ]),
    ],
  });
}

/** Attach per-function DynamoDB, archive, KMS, and connection-management grants. */
export function grantRuntimeLambdaAccess(input: {
  rest: NodejsFunction;
  websocket: NodejsFunction;
  cron: NodejsFunction;
  foundation: FoundationResources;
  websocketApiId: string;
}): void {
  const stack = input.rest.stack;
  const apiDataAccessPolicy = iam.ManagedPolicy.fromManagedPolicyArn(
    stack,
    "ImportedApiDataAccessPolicy",
    input.foundation.apiDataAccessPolicy.managedPolicyArn,
  );
  const archiveDataAccessPolicy = iam.ManagedPolicy.fromManagedPolicyArn(
    stack,
    "ImportedArchiveDataAccessPolicy",
    input.foundation.archiveDataAccessPolicy.managedPolicyArn,
  );
  for (const fn of [input.rest, input.websocket, input.cron]) {
    fn.role!.addManagedPolicy(apiDataAccessPolicy);
    fn.addToRolePolicy(manageConnectionsStatement(input.websocketApiId));
  }
  input.rest.role!.addManagedPolicy(archiveDataAccessPolicy);
  input.cron.role!.addManagedPolicy(archiveDataAccessPolicy);

  const keyArn = input.foundation.integrationKey.keyArn;
  input.rest.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["kms:Decrypt", "kms:Encrypt"], resources: [keyArn] }),
  );
  input.cron.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["kms:Decrypt"], resources: [keyArn] }),
  );
}
