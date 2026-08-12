import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("CmdDelScope");
const now = () => "2026-01-01T00:00:00.000Z";

describe("durable command deletion scope guards", () => {
  it("rejects provider defaults and every provider-account command override across restarts", async () => {
    if (!ctx.available || !ctx.storage) return;
    const writer = new ControlPlane({ storage: ctx.storage, now });
    expect(
      (
        await writer.createProviderDurable({
          id: "scope-provider",
          name: "scope-provider",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await writer.createCommandDurable({
          id: "scope-command",
          name: "scope-command",
          argv: ["echo"],
          providerId: "scope-provider",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await writer.createProviderAccountDurable({
          id: "scope-account",
          providerId: "scope-provider",
          label: "scope@example.test",
        })
      ).ok,
    ).toBe(true);

    expect(
      (await writer.updateProviderDurable("scope-provider", { defaultCommandId: "scope-command" }))
        .ok,
    ).toBe(true);
    await expect(deleteFromFreshPlane()).resolves.toMatchObject({
      ok: false,
      conflict: true,
      dependencies: [{ kind: "provider", id: "scope-provider" }],
    });
    expect(
      (await writer.updateProviderDurable("scope-provider", { defaultCommandId: null })).ok,
    ).toBe(true);

    await putInventory({ host: true });
    await expect(deleteFromFreshPlane()).resolves.toMatchObject({
      ok: false,
      conflict: true,
      dependencies: [
        {
          kind: "host-inventory",
          id: "scope-host",
          scope: "host",
          hostId: "scope-host",
        },
      ],
      error: expect.stringContaining("host scope-host command override"),
    });

    await putInventory({ repository: true });
    await expect(deleteFromFreshPlane()).resolves.toMatchObject({
      ok: false,
      conflict: true,
      dependencies: [
        {
          kind: "host-inventory",
          id: "scope-host",
          scope: "repository",
          hostId: "scope-host",
          repositoryId: "scope-repository",
        },
      ],
      error: expect.stringContaining(
        "repository scope-repository command override on host scope-host",
      ),
    });

    await putInventory({ worktree: true });
    await expect(deleteFromFreshPlane()).resolves.toMatchObject({
      ok: false,
      conflict: true,
      dependencies: [
        {
          kind: "host-inventory",
          id: "scope-host",
          scope: "worktree",
          hostId: "scope-host",
          repositoryId: "scope-repository",
          worktreeId: "scope-worktree",
        },
      ],
      error: expect.stringContaining("worktree scope-worktree command override on host scope-host"),
    });

    await putInventory({});
    await expect(deleteFromFreshPlane()).resolves.toEqual({ ok: true });

    async function deleteFromFreshPlane() {
      return new ControlPlane({ storage: ctx.storage!, now }).deleteCommandDurable("scope-command");
    }

    async function putInventory(scopes: {
      host?: boolean;
      repository?: boolean;
      worktree?: boolean;
    }) {
      const result = await writer.putHostInventoryDurable("scope-host", {
        repositories: [
          {
            id: "scope-repository",
            path: "/tmp/scope-repository",
            defaultBranch: "main",
            ...(scopes.repository
              ? {
                  providerAccountOverrides: {
                    "scope-account": { commandId: "scope-command" },
                  },
                }
              : {}),
            worktrees: [
              {
                id: "scope-worktree",
                name: "scope-worktree",
                path: "/tmp/scope-repository/scope-worktree",
                labels: [],
                ...(scopes.worktree
                  ? {
                      providerAccountOverrides: {
                        "scope-account": { commandId: "scope-command" },
                      },
                    }
                  : {}),
              },
            ],
          },
        ],
        providerAccounts: [
          {
            providerAccountId: "scope-account",
            ...(scopes.host ? { commandId: "scope-command" } : {}),
          },
        ],
        commandProfiles: {},
      });
      expect(result.ok).toBe(true);
    }
  });
});
