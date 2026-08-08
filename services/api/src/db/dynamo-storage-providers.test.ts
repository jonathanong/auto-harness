import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("StoPr");

describe("DynamoDB Local storage — providers/provider-accounts/commands", () => {
  it("persists providers, provider accounts, and commands", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const s = ctx.storage;

    await s.putProvider({
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await s.getProvider("prov-1"))?.name).toBe("claude");
    expect(await s.getProvider("nope")).toBeNull();
    expect((await s.listProviders()).length).toBeGreaterThan(0);

    await s.putProviderAccount({
      id: "acct-1",
      providerId: "prov-1",
      label: "jonathanrichardong@gmail.com",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await s.getProviderAccount("acct-1"))?.providerId).toBe("prov-1");
    expect(await s.getProviderAccount("nope")).toBeNull();
    expect((await s.listProviderAccounts()).length).toBeGreaterThan(0);

    await s.putCommand({
      id: "cmd-1",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await s.getCommand("cmd-1"))?.argv).toEqual(["claude", "-p"]);
    expect(await s.getCommand("nope")).toBeNull();
    expect((await s.listCommands()).length).toBeGreaterThan(0);

    await s.deleteProvider("prov-1");
    expect(await s.getProvider("prov-1")).toBeNull();
    await s.deleteProviderAccount("acct-1");
    expect(await s.getProviderAccount("acct-1")).toBeNull();
    await s.deleteCommand("cmd-1");
    expect(await s.getCommand("cmd-1")).toBeNull();
  });
});
