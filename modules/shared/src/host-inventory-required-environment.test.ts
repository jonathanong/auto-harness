import { describe, expect, it } from "vitest";

import { upsertHostRepository } from "./host-inventory.ts";

describe("upsertHostRepository required environment", () => {
  it("validates and normalizes names at the persistence boundary", () => {
    const inventory = upsertHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
      requiredEnvironment: ["Z_TOKEN", "A_TOKEN"],
    });
    expect(inventory.repositories[0]?.requiredEnvironment).toEqual(["A_TOKEN", "Z_TOKEN"]);
    expect(() =>
      upsertHostRepository(inventory, {
        id: "demo",
        path: "/repo",
        defaultBranch: "main",
        requiredEnvironment: ["TOKEN", "TOKEN"],
      }),
    ).toThrow("repository.demo.requiredEnvironment must not contain duplicate names");
  });
});
