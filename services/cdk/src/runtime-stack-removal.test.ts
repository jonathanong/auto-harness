import { App, RemovalPolicy } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

describe("AutoHarnessRuntimeStack removal", () => {
  it("deletes the integration key for a disposable runtime", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "DisposableFoundation", {
      dataRemovalPolicy: RemovalPolicy.DESTROY,
      tablePrefix: "DisposableRuntime",
    });
    const runtime = new AutoHarnessRuntimeStack(app, "DisposableRuntime", {
      dataRemovalPolicy: RemovalPolicy.DESTROY,
      foundation: foundation.resources,
      tablePrefix: "DisposableRuntime",
    });
    const key = Object.values(Template.fromStack(runtime).toJSON().Resources).find(
      (resource) => resource.Type === "AWS::KMS::Key",
    );
    expect(key?.DeletionPolicy).toBe("Delete");
    expect(key?.UpdateReplacePolicy).toBe("Delete");
  });
});
