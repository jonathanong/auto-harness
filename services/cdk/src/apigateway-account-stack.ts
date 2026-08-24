import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

/**
 * The account-level API Gateway → CloudWatch Logs role. This is an AWS-account-wide singleton
 * (one `AWS::ApiGateway::Account` per account/region, shared by every stack and every repo that
 * runs in this account) — it is deliberately not part of the per-environment Foundation/Runtime
 * stacks, which get destroyed and recreated per review environment. Deploy this once via
 * scripts/bootstrap-apigateway-account.sh, then opt individual deploys into access logs with
 * HARNESS_ACCESS_LOGS_ENABLED=1. Both the role and the account resource are RETAINed so that
 * destroying this stack never clears the account-wide setting out from under an unrelated stack.
 */
export class ApiGatewayAccountStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, "CloudWatchRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonAPIGatewayPushToCloudWatchLogs",
        ),
      ],
    });
    role.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const account = new apigateway.CfnAccount(this, "Account", {
      cloudWatchRoleArn: role.roleArn,
    });
    account.applyRemovalPolicy(RemovalPolicy.RETAIN);
  }
}
