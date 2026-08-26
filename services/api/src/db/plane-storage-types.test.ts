import { describe, expect, it } from "vitest";

import { itemToSession, normalizeTargetDisplayNames } from "./plane-storage-types.ts";

describe("target display-name hydration", () => {
  it("migrates the legacy targetLabels attribute and removes storage-only keys", () => {
    expect(
      itemToSession({
        id: "legacy-session",
        targetLabels: ["Codex", "Echo"],
        statusShard: "queued#0",
        queueOrder: "order",
      }),
    ).toEqual({
      id: "legacy-session",
      targetDisplayNames: ["Codex", "Echo"],
    });
  });

  it("prefers the current field while removing a leftover legacy attribute", () => {
    expect(
      normalizeTargetDisplayNames({
        id: "mixed-session",
        targetLabels: ["Legacy"],
        targetDisplayNames: ["Current"],
      }),
    ).toEqual({ id: "mixed-session", targetDisplayNames: ["Current"] });
  });
});
