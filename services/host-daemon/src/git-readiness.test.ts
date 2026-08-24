import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { gitVersionIsSupported, parseGitVersion, probeGitReadiness } from "./git-readiness.ts";

function runner(result: { exitCode?: number; stdout?: string; throws?: boolean }): ProcessRunner {
  return {
    async run(options) {
      if (result.throws) throw new Error("not on PATH: /secret/path");
      if (result.stdout) options.onChunk({ stream: "stdout", data: result.stdout });
      return { exitCode: result.exitCode ?? 0, timedOut: false, signal: null };
    },
  };
}

describe("Git checkout-recovery readiness", () => {
  it.each([
    ["git version 2.36.0\n", "2.36.0"],
    ["git version 2.36\n", "2.36.0"],
    ["git version 2.49.1 (Apple Git-155)\n", "2.49.1"],
  ])("parses supported Git output", (output, version) => {
    expect(parseGitVersion(output)).toBe(version);
    expect(gitVersionIsSupported(version)).toBe(true);
  });

  it("rejects an old Git release", async () => {
    await expect(
      probeGitReadiness(runner({ stdout: "git version 2.35.9\n" })),
    ).resolves.toMatchObject({
      gitVersion: "2.35.9",
      gitReady: false,
      gitReadinessReason: "git_version_unsupported",
    });
  });

  it("reports malformed output without retaining it", async () => {
    await expect(
      probeGitReadiness(runner({ stdout: "custom git build /private/secret" })),
    ).resolves.toEqual(
      expect.objectContaining({
        gitVersion: null,
        gitReady: false,
        gitReadinessReason: "git_version_unparseable",
      }),
    );
  });

  it("rejects unsafe numeric versions and incomplete support checks", () => {
    expect(parseGitVersion(`git version ${"9".repeat(400)}.36.0`)).toBeNull();
    expect(gitVersionIsSupported("2")).toBe(false);
    expect(gitVersionIsSupported(".36")).toBe(false);
    expect(gitVersionIsSupported("3.0")).toBe(true);
  });

  it.each([{ exitCode: 1 }, { throws: true }])("reports unavailable Git", async (result) => {
    await expect(probeGitReadiness(runner(result))).resolves.toEqual(
      expect.objectContaining({
        gitVersion: null,
        gitReady: false,
        gitReadinessReason: "git_unavailable",
      }),
    );
  });

  it("reports child-environment name semantics from the daemon platform", async () => {
    await expect(
      probeGitReadiness(runner({ stdout: "git version 2.36.0\n" }), "win32"),
    ).resolves.toMatchObject({ environmentNamesCaseSensitive: false });
    await expect(
      probeGitReadiness(runner({ stdout: "git version 2.36.0\n" }), "linux"),
    ).resolves.toMatchObject({ environmentNamesCaseSensitive: true });
  });
});
