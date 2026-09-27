import { sessionAssignFromWire } from "./session-assign.ts";
import { SessionRunner as ProductionSessionRunner } from "./session-runner.ts";
import { baseAssign, setup } from "../test-helpers/session-runner-test-helpers.ts";
import { applyExecutionProfile, parseExecutionProfiles } from "./execution-profiles.ts";
import { sanitizeCapturedSetupEnvironment } from "./setup-script-cache-store.ts";
import { mkdtemp, writeFile, symlink, rm, mkdir, link, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareSessionFeedback,
  readSessionFeedback,
  snapshotSessionFeedback,
  takeSessionFeedback,
} from "./session-feedback-artifact.ts";
import { feedbackCommandArgv } from "./session-feedback-instructions.ts";
import { createChildEnv } from "./child-env.ts";

const feedback = {
  schemaVersion: 1,
  completionKind: "no-change",
  feedbackCoverage: "complete",
  assessments: { architecture: "none-observed", sandbox: "none-observed", tools: "none-observed" },
  assessmentEvidence: {
    architecture: "Inspected the changed module boundary; no issue observed.",
    sandbox: "Inspected this attempt authorization and execution boundary; no issue observed.",
    tools: "No additional workflow tool was applicable to this scoped command.",
  },
  toolAssessments: [],
  findings: [],
  droppedCount: 0,
};

describe("host feedback artifact boundary", () => {
  it("refuses missing controller authorization before setup or provider execution", async () => {
    const runner = new ProductionSessionRunner({
      worktrees: {} as never,
      processRunner: {
        run: async () => {
          throw new Error("must not spawn");
        },
      },
    });
    expect(await runner.run(baseAssign())).toMatchObject({
      status: "failed",
      errorMessage: "Trusted controller command authorization is required",
    });
  });
  it("passes the mandatory contract through the real SessionRunner launch and receives its artifact", async () => {
    let launches = 0;
    const { sessionRunner } = setup({
      async run(options) {
        if (options.argv[0] === "codex") {
          launches += 1;
          expect(options.argv.at(-1)).toContain("Harness reporting requirement");
          expect(options.env?.HARNESS_FEEDBACK_INSTRUCTIONS).toContain("architecture");
          expect(options.env?.AGENT_BLACKBOARD_TOKEN).toBeUndefined();
          await writeFile(options.env!.HARNESS_FEEDBACK_PATH!, JSON.stringify(feedback));
        }
        return { exitCode: 0, timedOut: false, signal: null, agentSummary: "No changes needed." };
      },
    });
    const wire = {
      ...baseAssign({
        resolvedArgv: ["codex", "exec", "inspect repository"],
        feedbackPromptBindings: [{ index: 2, start: 0, end: 18 }],
      }),
      type: "session:assign" as const,
    };
    const result = await sessionRunner.run(sessionAssignFromWire(wire));
    expect(launches).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.result?.feedback).toEqual(feedback);
  });
  it("preserves a native resume prompt before trailing options through wire conversion and actual launch", async () => {
    const { sessionRunner } = setup({
      async run(options) {
        if (options.argv[0] === "codex") {
          expect(options.argv[3]).toContain("follow-up\n\nHarness reporting requirement");
          expect(options.argv.slice(4)).toEqual(["--model", "example"]);
          await writeFile(options.env!.HARNESS_FEEDBACK_PATH!, JSON.stringify(feedback));
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const wire = {
      ...baseAssign({
        resolvedArgv: ["codex", "resume", "native-ref", "follow-up", "--model", "example"],
        feedbackPromptBindings: [{ index: 3, start: 0, end: 9 }],
      }),
      type: "session:assign" as const,
    };
    expect((await sessionRunner.run(sessionAssignFromWire(wire))).result?.feedback).toEqual(
      feedback,
    );
  });
  it("blocks reporting namespace overlays and removes it from captured setup/cache environments", () => {
    expect(() =>
      parseExecutionProfiles({
        accounts: { account: { home: "/tmp", env: { AGENT_BLACKBOARD_TOKEN: "forbidden" } } },
      }),
    ).toThrow("reserved name");
    const env = applyExecutionProfile(
      { AGENT_BLACKBOARD_URL: "https://private.test" },
      {
        providerAccountId: "account",
        home: "/tmp",
        env: { AGENT_BLACKBOARD_TOKEN: "forbidden", VENDOR_TOKEN: "allowed" },
      },
      (path) => path,
    );
    expect(env.AGENT_BLACKBOARD_TOKEN).toBeUndefined();
    expect(env.AGENT_BLACKBOARD_URL).toBeUndefined();
    expect(env.VENDOR_TOKEN).toBe("allowed");
    expect(
      sanitizeCapturedSetupEnvironment({
        AGENT_BLACKBOARD_TOKEN: "forbidden",
        AGENT_BLACKBOARD_URL: "https://private.test",
        VENDOR_TOKEN: "allowed",
      }),
    ).toEqual({ VENDOR_TOKEN: "allowed" });
  });
  it("launches a provider with a concrete contract and collects its regular artifact", async () => {
    const assign = {};
    const path = await prepareSessionFeedback(assign);
    expect(await prepareSessionFeedback(assign)).toBe(path);
    const argv = feedbackCommandArgv(["codex", "exec", "inspect repository"], path, [
      { index: 2, start: 0, end: 18 },
    ]);
    expect(argv[2]).toContain("Harness reporting requirement");
    expect(argv[2]).toContain(path);
    expect(argv[2]).toContain("architecture");
    await writeFile(path, JSON.stringify(feedback));
    expect(await snapshotSessionFeedback(assign)).toEqual(feedback);
    expect(await takeSessionFeedback(assign)).toEqual(feedback);
    expect(await takeSessionFeedback(assign)).toBeUndefined();
    expect(await readSessionFeedback(path)).toBeUndefined();
  });
  it("rejects symlink, hardlink, directory, malformed, invalid and oversized files", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "feedback-test-")));
    try {
      const regular = join(directory, "regular");
      await writeFile(regular, JSON.stringify(feedback));
      const linked = join(directory, "linked");
      await symlink(regular, linked);
      expect(await readSessionFeedback(linked)).toBeUndefined();
      const hardlinked = join(directory, "hardlinked");
      await link(regular, hardlinked);
      expect(await readSessionFeedback(regular)).toBeUndefined();
      await rm(hardlinked);
      const folder = join(directory, "folder");
      await mkdir(folder);
      expect(await readSessionFeedback(folder)).toBeUndefined();
      await writeFile(regular, JSON.stringify({ ...feedback, unknownField: "private" }));
      expect(await readSessionFeedback(regular)).toBeUndefined();
      await writeFile(regular, "{");
      expect(await readSessionFeedback(regular)).toBeUndefined();
      await writeFile(regular, "x".repeat(8193));
      expect(await readSessionFeedback(regular)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("never forwards the writer credentials even when explicitly allowlisted", () => {
    expect(
      createChildEnv({
        PATH: "/bin",
        AGENT_BLACKBOARD_TOKEN: "test",
        AGENT_BLACKBOARD_URL: "https://example.test",
      }),
    ).toEqual({ PATH: "/bin" });
    expect(() =>
      createChildEnv({
        HARNESS_CHILD_ENV_ALLOWLIST: "AGENT_BLACKBOARD_TOKEN",
        AGENT_BLACKBOARD_TOKEN: "test",
      }),
    ).toThrow("reserved name");
    expect(feedbackCommandArgv(["echo", "hello"], "/tmp/feedback")).toEqual(["echo", "hello"]);
  });
});
