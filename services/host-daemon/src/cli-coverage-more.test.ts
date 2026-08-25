import { describe, expect, it } from "vitest";

import { runCli } from "./cli.ts";
import { deps } from "./cli-test-helpers.ts";

describe("CLI defensive error rendering", () => {
  it("keeps installing when update settings loading rejects with a non-Error", async () => {
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const subject = deps({
      loadConfig: async () => {
        throw "control plane unavailable";
      },
      installService: ({ env }) => {
        receivedEnv = env;
        return 0;
      },
    });

    await expect(
      runCli(["node", "cli", "install-service"], { HARNESS_HOST_ID: "host" }, subject),
    ).resolves.toBe(0);
    expect(subject.errors).toEqual([
      "Could not load host update settings; keeping local service settings: control plane unavailable",
    ]);
    expect(receivedEnv).toEqual({ HARNESS_HOST_ID: "host" });
  });

  it("renders a non-Error start failure without throwing from the CLI boundary", async () => {
    const subject = deps({
      ensureReady: async () => {
        throw "git client unavailable";
      },
    });

    await expect(runCli(["node", "cli", "start"], {}, subject)).resolves.toBe(1);
    expect(subject.errors).toContain("git client unavailable");
  });
});
