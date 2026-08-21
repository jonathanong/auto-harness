import { describe, expect, it } from "vitest";

import { assertAccountGrant, parseRepositoryScope } from "./auth-accounts.ts";

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

  it("rejects illegal role and scope combinations", () => {
    expect(() => assertAccountGrant("admin")).not.toThrow();
    expect(() => assertAccountGrant("agent", { boundHostId: "h" })).not.toThrow();
    expect(() => assertAccountGrant("admin", { allowedRepositoryIds: ["r"] })).toThrow(/admin/);
    expect(() => assertAccountGrant("operator", { boundHostId: "h" })).toThrow(/agent/);
  });
});
