import { describe, expect, it } from "vitest";

import {
  isHostRepositoryRegistration,
  validateHostRepositoryRegistrations,
} from "./host-registration.ts";

describe("host registration repository validation", () => {
  it("validates explicit repositories and duplicate IDs", () => {
    expect(isHostRepositoryRegistration({ id: "r", path: "/r" })).toBe(true);
    expect(isHostRepositoryRegistration({ id: "r", path: "" })).toBe(false);
    expect(validateHostRepositoryRegistrations([{ id: "r", path: "/r" }])).toBeNull();
    expect(
      validateHostRepositoryRegistrations([
        { id: "r", path: "/r" },
        { id: "r", path: "/other" },
      ]),
    ).toBe("duplicate repository r");
  });
});
