import { App, RemovalPolicy } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";

describe("AutoHarnessFoundationStack removal", () => {
  it("deletes the integration key with a disposable foundation", () => {
    const app = new App();
    const foundation = new AutoHarnessFoundationStack(app, "DisposableFoundation", {
      dataRemovalPolicy: RemovalPolicy.DESTROY,
      tablePrefix: "DisposableRuntime",
    });
    const keys = Object.values(Template.fromStack(foundation).findResources("AWS::KMS::Key"));
    expect(keys).toHaveLength(1);
    const [key] = keys;
    expect(key?.DeletionPolicy).toBe("Delete");
    expect(key?.UpdateReplacePolicy).toBe("Delete");
  });
});
