import { describe, expect, it } from "vitest";

import {
  assertAccountGrant,
  createServiceAccount,
  createUser,
  parseRepositoryScope,
} from "./auth-accounts.ts";

describe("account grant helpers", () => {
  it("parses repository scope from either field name", () => {
    expect(parseRepositoryScope({})).toBeUndefined();
    expect(parseRepositoryScope({ allowedRepositoryIds: ["repo-a"] })).toEqual(["repo-a"]);
    expect(parseRepositoryScope({ allowedRepositories: ["repo-b"] })).toEqual(["repo-b"]);
    expect(() => parseRepositoryScope({ allowedRepositoryIds: ["", "repo"] })).toThrow(
      /allowedRepositories/,
    );
    expect(() => parseRepositoryScope({ allowedRepositoryIds: [1] as never })).toThrow(
      /allowedRepositories/,
    );
  });

  it("rejects illegal role and scope combinations after remapping legacy shapes", () => {
    expect(() => assertAccountGrant("admin")).not.toThrow();
    expect(() => assertAccountGrant("agent", { boundHostId: "h" })).not.toThrow();
    expect(() => assertAccountGrant("admin", { allowedRepositoryIds: ["r"] })).not.toThrow();
    expect(() => assertAccountGrant("operator", { boundHostId: "h" })).not.toThrow();
    expect(() => assertAccountGrant("agent")).toThrow(/boundHostId/);
    expect(() => assertAccountGrant("read-only", { boundHostId: "h" })).toThrow(/agent/);
  });

  it("rejects invalid grants at both account creation boundaries", async () => {
    await expect(
      createUser(
        { username: "agent", password: "password", role: "agent" as never },
        new Map(),
        [],
      ),
    ).rejects.toThrow(/boundHostId/);
    await expect(createServiceAccount({ name: "agent", role: "agent" }, new Map())).rejects.toThrow(
      /boundHostId/,
    );
  });
});
