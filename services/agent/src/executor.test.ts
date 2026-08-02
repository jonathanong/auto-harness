import { describe, expect, it } from "vitest";

import { runSetupScript, type ProcessRunner } from "./executor.js";

describe("runSetupScript", () => {
  it("invokes /bin/sh -c with the script", async () => {
    let seen: string[] | undefined;
    const runner: ProcessRunner = {
      async run(opts) {
        seen = opts.argv;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await runSetupScript(runner, "true", "/tmp", 1000, () => undefined);
    expect(seen).toEqual(["/bin/sh", "-c", "true"]);
  });
});
