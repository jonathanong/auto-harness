import { describe, expect, it } from "vitest";

import { controlPlaneHydrateOptions } from "./create-plane.ts";

describe("controlPlaneHydrateOptions", () => {
  it("leaves default boot on the full hydrate path", () => {
    expect(controlPlaneHydrateOptions({})).toBeUndefined();
  });

  it("skips session history, catalogs, or both when those flags are false", () => {
    expect(controlPlaneHydrateOptions({ hydrateSessionHistory: false })).toEqual({
      sessionHistory: false,
      catalogs: true,
    });
    expect(controlPlaneHydrateOptions({ hydrateCatalogs: false })).toEqual({
      sessionHistory: true,
      catalogs: false,
    });
    expect(
      controlPlaneHydrateOptions({ hydrateSessionHistory: false, hydrateCatalogs: false }),
    ).toEqual({ sessionHistory: false, catalogs: false });
  });
});
