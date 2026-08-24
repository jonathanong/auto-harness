import { describe, expect, it } from "vitest";

import { createSupervisorRestartInstaller } from "./agent-updater-supervisor.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";
import { LINUX_ENV_DEST } from "./host-service-templates.ts";

describe("supervisor restart installer", () => {
  it("restarts the Linux unit after activate", async () => {
    const spawn = recorder();
    const installer = createSupervisorRestartInstaller(
      {
        stage: async () => undefined,
        activate: async () => undefined,
        rollback: async () => undefined,
      },
      baseOpts({
        platform: "linux",
        uid: 0,
        fs: seededFs({ [LINUX_ENV_DEST]: "HARNESS_HOST_ID=host-1\n" }),
        run: spawn.run,
      }),
    );
    await installer.stage({ version: "1.2.0", artifact: new Uint8Array() });
    await installer.activate("1.2.0");
    await installer.restart();
    expect(spawn.calls.map((call) => call.args.join(" "))).toContain(
      "restart auto-harness-host-daemon.service",
    );
  });

  it("fails closed when the supervisor restart command fails", async () => {
    const installer = createSupervisorRestartInstaller(
      {
        stage: async () => undefined,
        activate: async () => undefined,
        rollback: async () => undefined,
      },
      baseOpts({
        platform: "linux",
        uid: 0,
        run: () => ({ status: 1, stdout: "", stderr: "failed" }),
      }),
    );
    await expect(installer.restart()).rejects.toThrow("supervisor restart failed");
  });
});
