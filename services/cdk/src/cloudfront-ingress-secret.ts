import type { Construct } from "constructs";

import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

/** Creates the origin credential accepted by the API Gateway ingress authorizer. */
export function cloudFrontIngressSecret(scope: Construct): secretsmanager.Secret {
  return new secretsmanager.Secret(scope, "CloudFrontIngressSecret", {
    // CloudFront sends this only to the API origin as a custom header.
    generateSecretString: { excludeCharacters: "\"'\\\\`\r\n" },
  });
}
