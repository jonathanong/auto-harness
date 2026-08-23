import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import type { AuthStorage } from "./auth-accounts.ts";

const fence = { key: "principal:user:alice", owner: "owner", now: "2026-08-23T00:00:00.000Z" };

function storage(result: "deleted" | "missing" | "fence-lost"): AuthStorage {
  return {
    listAuthAccounts: async () => [],
    putAuthAccount: async () => undefined,
    deleteAuthAccount: async () => undefined,
    deleteAuthAccountFenced: async () => result,
  };
}

describe("fenced account deletion", () => {
  it("removes users only after their durable fenced deletion succeeds", async () => {
    const auth = new AuthService({ mode: "disabled" });
    await auth.createUser({ username: "alice", password: "password", role: "operator" });

    await expect(auth.deleteUserFenced("missing", storage("deleted"), fence)).resolves.toBe(
      "missing",
    );
    await expect(auth.deleteUserFenced("alice", storage("fence-lost"), fence)).resolves.toBe(
      "fence-lost",
    );
    expect(auth.listUsers()).toHaveLength(1);
    await expect(auth.deleteUserFenced("alice", storage("deleted"), fence)).resolves.toBe(
      "deleted",
    );
    expect(auth.listUsers()).toHaveLength(0);
  });

  it("evicts a stale cache miss, keeps fence loss cached, and never bypasses a requested fence", async () => {
    const auth = new AuthService({ mode: "disabled" });
    const first = await auth.createServiceAccount({ name: "first", role: "operator" });
    await expect(
      auth.deleteServiceAccountFenced(first.account.id, storage("missing"), fence),
    ).resolves.toBe("missing");
    expect(auth.listServiceAccounts()).toHaveLength(0);

    const fallback: AuthStorage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
    };
    const second = await auth.createServiceAccount({ name: "second", role: "operator" });
    await expect(auth.deleteServiceAccountFenced(second.account.id, fallback, fence)).resolves.toBe(
      "fence-lost",
    );
    expect(auth.listServiceAccounts()).toHaveLength(1);
    await expect(
      auth.deleteServiceAccountFenced(second.account.id, fallback, undefined),
    ).resolves.toBe("deleted");
    await expect(
      auth.deleteServiceAccountFenced(second.account.id, undefined, undefined),
    ).resolves.toBe("missing");
  });
});
