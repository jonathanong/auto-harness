import { describe, expect, it } from "vitest";

import { updateHostRequiredEnvironment, upsertHostRepository } from "./host-inventory.ts";

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

  it("rejects host and repository requirements that cannot fit in one runtime report", () => {
    const hostRequirements = Array.from({ length: 256 }, (_, index) => `HOST_${index}`);
    const inventory = updateHostRequiredEnvironment(null, hostRequirements);
    expect(() =>
      upsertHostRepository(inventory, {
        id: "demo",
        path: "/repo",
        defaultBranch: "main",
        requiredEnvironment: ["REPOSITORY"],
      }),
    ).toThrow("must contain at most 256 distinct names");

    const repositoryInventory = upsertHostRepository(null, {
      id: "demo",
      path: "/repo",
      defaultBranch: "main",
      requiredEnvironment: hostRequirements,
    });
    expect(() => updateHostRequiredEnvironment(repositoryInventory, ["HOST_REQUIREMENT"])).toThrow(
      "must contain at most 256 distinct names",
    );
  });
});
