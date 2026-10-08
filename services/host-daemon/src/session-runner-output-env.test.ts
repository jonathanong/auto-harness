import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import { makeRunner } from "../test-helpers/session-runner-main-test-helpers.ts";
import { SessionOutputSpool } from "./session-output-spool.ts";

describe("SessionRunner output environment", () => {
  it("injects private per-attempt paths after child filtering into command and terminal hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-output-runner-"));
    try {
      const spool = new SessionOutputSpool({ root });
      const test = makeRunner({
        sessionOutputSpool: spool,
        childEnvSource: {
          HARNESS_OUTPUT_FILE: "/ambient/output.json",
          HARNESS_ARTIFACTS_DIR: "/ambient/artifacts",
          HARNESS_API_KEY: "never-forward",
        },
      });
      const result = await test.runner.run(
        baseAssign({
          repositoryId: "r1",
          worktreeId: null,
          sessionType: "scheduled",
          outputs: true,
        } as Partial<import("@auto-harness/shared").SessionAssign>),
      );
      expect(result.outputsJobId).toBeTruthy();
      expect(test.starts).toEqual(["/repo-1"]);
      const outputFile = test.commandEnvs[0]?.HARNESS_OUTPUT_FILE;
      const artifactsDir = test.commandEnvs[0]?.HARNESS_ARTIFACTS_DIR;
      expect(outputFile).toContain(join(root, "attempts"));
      expect(artifactsDir).toContain(join(root, "attempts"));
      expect(test.commandEnvs[0]?.HARNESS_API_KEY).toBeUndefined();
      expect(test.hookEnvs[0]?.HARNESS_OUTPUT_FILE).toBe(outputFile);
      expect(test.hookEnvs[0]?.HARNESS_ARTIFACTS_DIR).toBe(artifactsDir);
      const jobs = await readdir(join(root, "jobs"));
      expect(jobs).toHaveLength(1);
      const stored = JSON.parse(
        await readFile(join(root, "jobs", jobs[0]!, "job.json"), "utf8"),
      ) as {
        output: { state: string };
      };
      expect(stored.output).toEqual({ state: "none" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
