import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { AutoHarnessFoundationStack } from "./foundation-stack.ts";
import { AutoHarnessRuntimeStack } from "./runtime-stack.ts";

function runtimeTemplate() {
  const app = new App();
  const foundation = new AutoHarnessFoundationStack(app, "Foundation", {
    tablePrefix: "ReviewRuntime",
  });
  const runtime = new AutoHarnessRuntimeStack(app, "Runtime", {
    foundation: foundation.resources,
    tablePrefix: "ReviewRuntime",
  });
  return Template.fromStack(runtime);
}

function functionByHandler(template: Template, handler: string) {
  return Object.values(template.findResources("AWS::Lambda::Function")).find(
    (fn) => fn.Properties?.Handler === handler,
  );
}

function roleLogicalId(template: Template, handler: string): string {
  const fn = functionByHandler(template, handler);
  const role = fn?.Properties?.Role?.["Fn::GetAtt"]?.[0];
  if (typeof role !== "string") throw new Error(`missing role for ${handler}`);
  return role;
}

function policyDocuments(template: Template, handler: string): unknown[] {
  const role = roleLogicalId(template, handler);
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((policy) => JSON.stringify(policy.Properties?.Roles ?? []).includes(role))
    .flatMap((policy) => policy.Properties?.PolicyDocument?.Statement ?? []);
}

function policyActions(template: Template, handler: string): string[] {
  return policyDocuments(template, handler).flatMap((statement) => {
    const action = (statement as { Action?: string | string[] }).Action;
    return action === undefined ? [] : Array.isArray(action) ? action : [action];
  });
}

describe("runtime Lambda IAM split", () => {
  it("gives archive and integration KMS encrypt only to REST and Cron", () => {
    const template = runtimeTemplate();
    const restRole = roleLogicalId(template, "index.rest");
    const cronRole = roleLogicalId(template, "index.cron");
    const websocketRole = roleLogicalId(template, "index.websocket");
    const archiveRoles = Object.values(template.findResources("AWS::IAM::Role")).filter((role) =>
      JSON.stringify(role.Properties?.ManagedPolicyArns ?? []).includes("ArchiveDataAccessPolicy"),
    );
    expect(archiveRoles).toHaveLength(2);

    const rest = policyActions(template, "index.rest");
    const cron = policyActions(template, "index.cron");
    const websocket = policyActions(template, "index.websocket");
    expect(rest).toContain("kms:Encrypt");
    expect(rest).toContain("kms:Decrypt");
    expect(cron).toContain("kms:Decrypt");
    expect(cron).not.toContain("kms:Encrypt");
    expect(websocket).not.toContain("kms:Encrypt");

    const websocketFn = functionByHandler(template, "index.websocket");
    expect(websocketFn?.Properties?.Environment?.Variables?.KMS_KEY_ID).toBeUndefined();
    expect(websocketFn?.Properties?.Environment?.Variables?.ARCHIVE_BUCKET).toBeUndefined();
    expect(
      functionByHandler(template, "index.rest")?.Properties?.Environment?.Variables?.KMS_KEY_ID,
    ).toBeDefined();
    expect(restRole).not.toEqual(websocketRole);
    expect(cronRole).not.toEqual(websocketRole);
  });

  it("keeps ManageConnections on every runtime function", () => {
    const template = runtimeTemplate();
    template.resourcePropertiesCountIs(
      "AWS::IAM::Policy",
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "execute-api:ManageConnections",
              Effect: "Allow",
            }),
          ]),
        },
      },
      3,
    );
  });
});
