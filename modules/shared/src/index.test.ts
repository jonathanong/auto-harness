import { describe, expect, it } from "vitest";

import * as shared from "./index.js";

describe("package exports", () => {
  it("re-exports validation helpers and constants", () => {
    expect(typeof shared.validateCreateSessionInput).toBe("function");
    expect(typeof shared.formatLogSortKey).toBe("function");
    expect(shared.SESSION_STATUSES.length).toBeGreaterThan(0);
    expect(shared.PACKAGE_SCOPE).toBe("@auto-harness");
  });
});
