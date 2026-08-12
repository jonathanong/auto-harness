import { App, RemovalPolicy } from "aws-cdk-lib";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

function contextString(app: App, key: string): string | undefined {
  const value = app.node.tryGetContext(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function removalPolicy(value: string | undefined): RemovalPolicy {
  if (value === undefined || value === "retain") return RemovalPolicy.RETAIN;
  if (value === "destroy") return RemovalPolicy.DESTROY;
  throw new Error("removalPolicy context must be either retain or destroy");
}

const app = new App();
const tablePrefix = contextString(app, "tablePrefix") ?? "AutoHarness";
const stack = new AutoHarnessFoundationStack(
  app,
  contextString(app, "stackName") ?? "AutoHarnessFoundation",
  {
    archiveBucketName: contextString(app, "archiveBucketName"),
    dataRemovalPolicy: removalPolicy(contextString(app, "removalPolicy")),
    tablePrefix,
  },
);
void stack;
const runtime = new AutoHarnessRuntimeStack(
  app,
  contextString(app, "runtimeStackName") ?? "AutoHarnessRuntime",
  { foundation: stack.resources, tablePrefix },
);
runtime.addStackDependency(stack);
