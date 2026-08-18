import { describe, expect, it } from "vitest";

import { computePorts, fnv1a } from "./worktree-e2e-env.mts";

describe("fnv1a", () => {
  it("is deterministic and well-distributed for similar inputs", () => {
    expect(fnv1a("mellow-herding-mountain")).toBe(fnv1a("mellow-herding-mountain"));
    expect(fnv1a("mellow-herding-mountain")).not.toBe(fnv1a("mellow-herding-mountains"));
    expect(fnv1a("")).toBe(0x811c9dc5);
  });
});

describe("computePorts", () => {
  it("derives a stable, non-overlapping 4-port block above the shared default stack", () => {
    const ports = computePorts("mellow-herding-mountain");
    expect(ports).toEqual(computePorts("mellow-herding-mountain"));
    expect(ports.offset).toBeGreaterThanOrEqual(10);
    expect(ports.offset % 4).toBe(2); // 10 + 4*bucket ≡ 2 (mod 4)
    expect(ports.apiPort).toBe(7430 + ports.offset);
    expect(ports.controlPort).toBe(ports.apiPort + 1);
    expect(ports.hostPanePort).toBe(ports.apiPort + 2);
    expect(ports.dynamoPort).toBe(ports.apiPort + 3);
    expect(ports.containerName).toBe("mellow-herding-mountain-dynamodb-e2e");
  });

  it("gives different worktree names different port blocks", () => {
    const a = computePorts("worktree-a");
    const b = computePorts("worktree-b");
    expect(a.offset).not.toBe(b.offset);
  });

  it("never lands on the shared default offset (0)", () => {
    // 10 + bucket*4 is always >= 10, so it can never equal 0 regardless of the hash.
    expect(computePorts("").offset).toBeGreaterThanOrEqual(10);
  });
});
