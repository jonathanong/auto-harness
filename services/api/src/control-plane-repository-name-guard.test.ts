import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("repository name validation", () => {
  it("rejects an invalid name on update without changing the saved repository", () => {
    const plane = new ControlPlane();
    expect(plane.createRepository({ id: "repo-1", name: "repo-1", url: "/repo" }).ok).toBe(true);

    expect(plane.updateRepository("repo-1", { name: "not a slug" })).toEqual({
      ok: false,
      error: "name must be lowercase letters, numbers, and dashes only (e.g. my-repo-name)",
    });
    expect(plane.getRepository("repo-1")?.name).toBe("repo-1");
  });
});
