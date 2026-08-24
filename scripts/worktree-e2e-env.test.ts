import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:net", () => ({ connect: vi.fn() }));

const { spawnSync } = await import("node:child_process");
const { connect } = await import("node:net");
const { bucketFor, computePorts, envFor, findAvailablePorts, fnv1a, portsForBucket } =
  await import("./worktree-e2e-env.mts");

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.mocked(connect).mockReset();
});

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

  it("sets HARNESS_PUBLIC_BASE_URL to this worktree's control UI origin", () => {
    const ports = computePorts("mellow-herding-mountain");
    expect(envFor(ports).HARNESS_PUBLIC_BASE_URL).toBe(`http://127.0.0.1:${ports.controlPort}`);
    expect(envFor(ports).HARNESS_API_HTTP).toBe(`http://127.0.0.1:${ports.apiPort}`);
  });

  it("never lands on the shared default offset (0)", () => {
    // 10 + bucket*4 is always >= 10, so it can never equal 0 regardless of the hash.
    expect(computePorts("").offset).toBeGreaterThanOrEqual(10);
  });
});

describe("bucketFor / portsForBucket", () => {
  it("computePorts is portsForBucket applied to bucketFor's result", () => {
    expect(computePorts("worktree-a")).toEqual(
      portsForBucket("worktree-a", bucketFor("worktree-a")),
    );
  });

  it("walking to the next bucket shifts every port by exactly 4", () => {
    const bucket = bucketFor("worktree-a");
    const here = portsForBucket("worktree-a", bucket);
    const next = portsForBucket("worktree-a", bucket + 1);
    expect(next.offset).toBe(here.offset + 4);
    expect(next.apiPort).toBe(here.apiPort + 4);
  });
});

function fakeSocket(willConnect: boolean) {
  const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit(willConnect ? "connect" : "timeout"));
  return socket;
}

describe("findAvailablePorts", () => {
  it("accepts the hash-seeded bucket when every port is free and the container doesn't exist", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as never);
    vi.mocked(connect).mockImplementation(() => fakeSocket(false) as never);

    const ports = await findAvailablePorts("worktree-a");
    expect(ports).toEqual(computePorts("worktree-a"));
  });

  it("treats a port already bound to this worktree's own (running) container as available", async () => {
    vi.mocked(spawnSync).mockImplementation(
      (_cmd, args) =>
        ({ status: 0, stdout: (args as string[])?.includes("-f") ? "true" : "" }) as never,
    );
    vi.mocked(connect).mockImplementation(() => fakeSocket(false) as never);

    const ports = await findAvailablePorts("worktree-a");
    expect(ports).toEqual(computePorts("worktree-a"));
  });

  it("walks to the next bucket when a port is occupied by something else", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as never); // no container of ours anywhere
    const occupied = computePorts("worktree-a").apiPort;
    vi.mocked(connect).mockImplementation(
      (opts) => fakeSocket((opts as unknown as { port: number }).port === occupied) as never,
    );

    const ports = await findAvailablePorts("worktree-a");
    expect(ports).toEqual(portsForBucket("worktree-a", bucketFor("worktree-a") + 1));
  });

  it("throws once every candidate within maxAttempts is occupied", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as never);
    vi.mocked(connect).mockImplementation(() => fakeSocket(true) as never);

    await expect(findAvailablePorts("worktree-a", 3)).rejects.toThrow(
      /Could not find a free e2e port block/,
    );
  });
});
