import { App } from "aws-cdk-lib";

import { ApiGatewayAccountStack } from "./apigateway-account-stack.ts";

const app = new App();
const stack = new ApiGatewayAccountStack(app, "AutoHarnessApiGatewayAccount");
void stack;
