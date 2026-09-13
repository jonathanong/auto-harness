import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";

function encryptor(): SecretEncryptor {
  return {
    encrypt: async (value) => `cipher:${Buffer.from(value).toString("base64")}`,
    decrypt: async (value) => Buffer.from(value.slice("cipher:".length), "base64").toString("utf8"),
  };
}

function config() {
  return {
    id: "deploy",
    secret: "s".repeat(32),
    repositoryId: "repo",
    target: { providerId: "provider" },
    timeout: 60,
  } as never;
}

describe("durable custom webhook integrations", () => {
  it("uses durable reads and writes, including compare-and-swap failures", async () => {
    let stored: Awaited<ReturnType<ControlPlane["getCustomWebhookIntegrationRecord"]>> = null;
    let writeAllowed = true;
    const storage = {
      getRepository: async () => ({ id: "repo" }),
      listProviders: async () => [{ id: "provider" }],
      listCommands: async () => [{ id: "command" }],
      getCustomWebhookIntegration: async () => stored,
      putCustomWebhookIntegration: async (record: NonNullable<typeof stored>) => {
        if (writeAllowed) stored = record;
        return writeAllowed;
      },
      deleteCustomWebhookIntegration: async () => {
        if (writeAllowed) stored = null;
        return writeAllowed;
      },
    };
    const value = new ControlPlane({ secretEncryptor: encryptor(), storage: storage as never });

    expect(await value.getCustomWebhookIntegration("deploy")).toBeNull();
    expect(await value.createCustomWebhookIntegration(config())).toMatchObject({ ok: true });
    expect(await value.getCustomWebhookIntegration("deploy")).toMatchObject({ id: "deploy" });

    writeAllowed = false;
    expect(await value.updateCustomWebhookIntegration(config())).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(await value.deleteCustomWebhookIntegration("deploy")).toMatchObject({
      ok: false,
      conflict: true,
    });

    writeAllowed = true;
    expect(
      await value.updateCustomWebhookIntegration({ ...config(), secret: undefined }),
    ).toMatchObject({ ok: true, integration: { version: 2 } });
    expect(await value.deleteCustomWebhookIntegration("deploy")).toEqual({ ok: true });
  });

  it("fences writes against catalog deletion", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    let markers: unknown;
    const storage = {
      getRepository: async () => ({ id: "repo" }),
      listProviders: async () => [{ id: "provider" }],
      listCommands: async () => [{ id: "command" }],
      getCustomWebhookIntegration: async () => null,
      acquireDeletionMarker: async (key: string) => {
        acquired.push(key);
        return true;
      },
      releaseDeletionMarker: async (key: string) => void released.push(key),
      putCustomWebhookIntegration: async (_record: unknown, _version: unknown, value: unknown) => {
        markers = value;
        return true;
      },
    };
    const value = new ControlPlane({ secretEncryptor: encryptor(), storage: storage as never });
    await expect(value.createCustomWebhookIntegration(config())).resolves.toMatchObject({
      ok: true,
    });
    expect(acquired).toEqual(["provider:provider", "repository:repo"]);
    expect(markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "provider:provider" }),
        expect.objectContaining({ key: "repository:repo" }),
      ]),
    );
    expect(released).toEqual(["provider:provider", "repository:repo"]);
  });
});
