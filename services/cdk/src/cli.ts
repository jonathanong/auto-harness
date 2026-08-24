import { App, RemovalPolicy } from "aws-cdk-lib";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { fileURLToPath } from "node:url";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";
import { AutoHarnessWebStack } from "./web-stack.ts";

function contextString(app: App, key: string): string | undefined {
  const value = app.node.tryGetContext(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contextBoolean(app: App, key: string): boolean {
  return contextString(app, key) === "true";
}

function removalPolicy(value: string | undefined): RemovalPolicy {
  if (value === undefined || value === "retain") return RemovalPolicy.RETAIN;
  if (value === "destroy") return RemovalPolicy.DESTROY;
  throw new Error("removalPolicy context must be either retain or destroy");
}

const app = new App();
const tablePrefix = contextString(app, "tablePrefix") ?? "AutoHarness";
const dataRemovalPolicy = removalPolicy(contextString(app, "removalPolicy"));
const archiveBucketName = contextString(app, "archiveBucketName");
const stack = new AutoHarnessFoundationStack(
  app,
  contextString(app, "stackName") ?? "AutoHarnessFoundation",
  {
    ...(archiveBucketName !== undefined ? { archiveBucketName } : {}),
    dataRemovalPolicy,
    tablePrefix,
  },
);
void stack;
const runtime = new AutoHarnessRuntimeStack(
  app,
  contextString(app, "runtimeStackName") ?? "AutoHarnessRuntime",
  {
    foundation: stack.resources,
    tablePrefix,
    accessLogsEnabled: contextBoolean(app, "accessLogsEnabled"),
  },
);
runtime.addStackDependency(stack);
const web = new AutoHarnessWebStack(app, contextString(app, "webStackName") ?? "AutoHarnessWeb", {
  imageCode: lambda.DockerImageCode.fromImageAsset(
    fileURLToPath(new URL("../../..", import.meta.url)),
    { file: "services/web/Dockerfile.aws", platform: Platform.LINUX_ARM64 },
  ),
  restApiUrl: runtime.resources.restApiUrl,
  websocketUrl: runtime.resources.websocketUrl,
});
web.addStackDependency(runtime);
