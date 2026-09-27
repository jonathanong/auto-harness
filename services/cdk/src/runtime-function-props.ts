import { fileURLToPath } from "node:url";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";

const lambdaEntry = fileURLToPath(new URL("../../api/src/lambda-handlers.ts", import.meta.url));
export const runtimeFunctionProps = {
  bundling: {
    externalModules: [],
    minify: true,
    sourceMap: true,
  },
  entry: lambdaEntry,
  memorySize: 256,
  runtime: lambda.Runtime.NODEJS_24_X,
} satisfies Partial<nodejs.NodejsFunctionProps>;
