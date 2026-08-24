import { describe, expect, it } from "vitest";

import { createSupervisorRestartInstaller } from "./agent-updater-supervisor.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";

describe("supervisor restart installer", () => {
  it("hands Linux restart back to the authorized service process without systemctl", async () => {
    const spawn = recorder();
    let handoffs = 0;
    const installer = createSupervisorRestartInstaller(
      {
        stage: async () => undefined,
        activate: async () => undefined,
        rollback: async () => undefined,
      },
      baseOpts({
        platform: "linux",
        uid: 0,
        fs: seededFs(),
        run: spawn.run,
        restartHandoff: () => {
          handoffs += 1;
        },
      }),
    );
    await installer.stage({ version: "1.2.0", artifact: new Uint8Array() });
    await installer.activate("1.2.0");
    await installer.restart();
    expect(handoffs).toBe(1);
    expect(spawn.calls).toEqual([]);
  });

  it("fails closed when Linux has no authorized restart handoff", async () => {
    const installer = createSupervisorRestartInstaller(
      {
        stage: async () => undefined,
        activate: async () => undefined,
        rollback: async () => undefined,
      },
      baseOpts({
        platform: "linux",
        uid: 0,
        run: () => ({ status: 1, stdout: "", stderr: "must not run" }),
      }),
    );
    await expect(installer.restart()).rejects.toThrow("supervisor restart failed");
  });
});
