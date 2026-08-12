import { describe, expect, it } from "vitest";

import { newId } from "./id.ts";
import { isValidSlugName } from "./slug.ts";

describe("identity helpers", () => {
  it("creates opaque identifiers and validates slug names", () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(isValidSlugName("audit-log")).toBe(true);
    expect(isValidSlugName("audit log")).toBe(false);
  });
});
