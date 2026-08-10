import { describe, expect, it } from "vitest";

import {
  isHostRepositoryRegistration,
  validateHostRepositoryRegistrations,
} from "./host-registration.ts";

describe("host repository registration edge validation", () => {
  it("rejects non-records and malformed optional branches", () => {
    for (const value of [null, [], "repository", { id: "", path: "/repo" }, { id: "r", path: 1 }]) {
      expect(isHostRepositoryRegistration(value)).toBe(false);
    }
    expect(isHostRepositoryRegistration({ id: "r", path: "/repo", defaultBranch: "" })).toBe(false);
    expect(isHostRepositoryRegistration({ id: "r", path: "/repo", defaultBranch: "main" })).toBe(
      true,
    );
    expect(validateHostRepositoryRegistrations([{ id: "", path: "/repo" }])).toBe(
      "invalid repository registration",
    );
  });
});
