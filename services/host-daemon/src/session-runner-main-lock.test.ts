import { describe, expect, it } from "vitest";

import { baseAssign } from "./session-runner-test-helpers.ts";
import { deferred, makeRunner, viTick } from "./session-runner-main-test-helpers.ts";

describe("SessionRunner main checkout lock cleanup", () => {
  it("times out a queued session without running its terminal hook", async () => {
    const test = makeRunner();
    const firstGate = deferred();
    test.waits.set("/repo-1", firstGate);
    const first = test.runner.run(
      baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
    );
    await viTick();
    const queued = test.runner.run(
      baseAssign({
        repositoryId: "r1",
        worktreeId: null,
        sessionType: "scheduled",
        timeout: 0.01,
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await expect(queued).resolves.toMatchObject({ status: "timed_out" });
    expect(test.hooks).toEqual([]);
    firstGate.resolve();
    await first;
  });

  it("releases the main lock after checkout and setup failures", async () => {
    const test = makeRunner();
    test.throwCheckout.value = true;
    await expect(
      test.runner.run(
        baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
      ),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      test.runner.run(
        baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
    test.throwSetup.value = true;
    await expect(
      test.runner.run(
        baseAssign({
          repositoryId: "r1",
          worktreeId: null,
          sessionType: "scheduled",
          setupScript: "setup",
        }),
      ),
    ).rejects.toThrow("setup failed");
    await expect(
      test.runner.run(
        baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
