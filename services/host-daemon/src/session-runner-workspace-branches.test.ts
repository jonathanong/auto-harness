import { describe, expect, it } from "vitest";
import type { SessionAssign } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import { SessionRunner } from "./session-runner.ts";

const processRunner: ProcessRunner = {
  async run() {
    return { exitCode: 0, timedOut: false, signal: null };
  },
};

function assignment(patch: Partial<SessionAssign> = {}): SessionAssign {
  return {
    sessionId: "workspace-session",
    attemptId: "attempt",
    repositoryId: null,
    sessionType: "workspace",
    workspacePoolId: "pool",
    workspaceSlotId: "slot",
    prompt: "run",
    resolvedArgv: ["echo", "ok"],
    timeout: 30,
    worktreeId: null,
    ...patch,
  };
}

function runner(workspaces?: object) {
  return new SessionRunner({
    worktrees: {} as never,
    ...(workspaces ? { workspaces: workspaces as never } : {}),
    processRunner,
  });
}

describe("SessionRunner workspace validation branches", () => {
  it.each([
    [{ workspacePoolId: "" }, "workspace assignment is missing"],
    [{ workspaceSlotId: "" }, "workspace assignment is missing"],
    [{ workspacePoolId: undefined }, "workspace assignment is missing"],
    [{ workspaceSlotId: undefined }, "workspace assignment is missing"],
  ])("rejects incomplete workspace wire fields", async (patch, message) => {
    const result = await runner({}).run(assignment(patch));
    expect(result).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining(message),
    });
  });

  it("rejects a missing workspace manager", async () => {
    await expect(runner().run(assignment())).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("configured workspace manager"),
    });
  });

  it("fails closed when a non-workspace assignment omits its repository", async () => {
    await expect(
      runner().run(
        assignment({
          sessionType: "prompt",
          repositoryId: null,
          worktreeId: "worktree",
        }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: "repositoryId is required",
    });
  });

  it.each([{ resume: true }, { priorContext: {} as never }])(
    "rejects continuation-only fields",
    async (patch) => {
      await expect(runner({}).run(assignment(patch))).resolves.toMatchObject({
        status: "failed",
        errorMessage: expect.stringContaining("do not support resume"),
      });
    },
  );

  it("reports a workspace claim failure", async () => {
    const workspaces = {
      async claim() {
        throw new Error("slot vanished");
      },
    };
    await expect(runner(workspaces).run(assignment())).resolves.toMatchObject({
      status: "failed",
      errorMessage: "slot vanished",
    });
  });

  it("reports cancellation while waiting for a workspace claim", async () => {
    const controller = new AbortController();
    const workspaces = {
      async claim(_pool: string, _slot: string, signal: AbortSignal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort();
        });
      },
    };
    await expect(
      runner(workspaces).run(assignment(), { signal: controller.signal }),
    ).resolves.toMatchObject({ status: "cancelled", exitCode: null });
  });

  it("reports timeout while waiting for a workspace claim", async () => {
    const workspaces = {
      async claim(_pool: string, _slot: string, signal: AbortSignal) {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    };
    await expect(runner(workspaces).run(assignment({ timeout: 0.001 }))).resolves.toMatchObject({
      status: "timed_out",
      exitCode: null,
    });
  });
});
