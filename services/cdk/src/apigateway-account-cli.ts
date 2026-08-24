import { App } from "aws-cdk-lib";

import { ApiGatewayAccountStack } from "./apigateway-account-stack.ts";

const app = new App();
void new ApiGatewayAccountStack(app, "ApiGatewayAccount");
