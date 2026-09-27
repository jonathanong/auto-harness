import { describe, expect, it } from "vitest";
import { blackboardServer } from "../test-helpers/blackboard-server.ts";
import { createBlackboardReporting, reportingPolicyFields } from "./blackboard-reporting.ts";
import { parseBlackboardConfig } from "./blackboard-config.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { config, session } from "../test-helpers/blackboard-reporting-fixtures.ts";

describe("trusted Blackboard reporting", () => {
  it("validates deployment policy without leaking malformed configuration", () => {
    expect(parseBlackboardConfig(JSON.stringify(config())).policies).toHaveLength(1);
    expect(() => parseBlackboardConfig('{"token":"private-value"}')).toThrow(
      "invalid Blackboard reporting configuration",
    );
    expect(() => parseBlackboardConfig(JSON.stringify(config("http://untrusted.example")))).toThrow(
      "invalid Blackboard reporting URL",
    );
    expect(() =>
      parseBlackboardConfig(
        JSON.stringify({ ...config(), policies: [config().policies[0], config().policies[0]] }),
      ),
    ).toThrow("duplicate");
    expect(reportingPolicyFields(undefined, "repo", "user:operator")).toEqual({
      reportingMode: "autonomous",
      reportingAgentVersion: "unknown",
    });
  });
  it("fresh writes and readback precede command authorization; duplicate/stale attempts cannot bypass", async () => {
    const server = await blackboardServer();
    try {
      const reporting = createBlackboardReporting(config(server.url));
      const state = createControlPlaneState({ blackboardReporting: reporting });
      let stored = session();
      let commits = 0;
      state.storage = {
        recordBlackboardAdmissionBlock: async (_id: string, blocked: boolean) => {
          stored.reportingAdmissionBlocked = blocked;
          return true;
        },
        getSession: async () => stored,
        getHostLock: async () => "connection",
        authorizePrimaryCommandStart: async () => {
          if (stored.primaryCommandStartState === "authorized") return true;
          expect(server.entries.get("session")).toHaveLength(1);
          commits += 1;
          stored = {
            ...stored,
            primaryCommandStartState: "authorized",
            reportingAdmissionAttemptId: "attempt",
          };
          return true;
        },
      } as never;
      const message = {
        type: "session:command-start" as const,
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
      };
      server.state.refuse = true;
      expect(await handleHostMessageDurable(state, message, "connection")).toEqual({ ok: true });
      expect(commits).toBe(0);
      server.state.refuse = false;
      server.state.hideReadback = true;
      expect(await handleHostMessageDurable(state, message, "connection")).toEqual({ ok: true });
      expect(commits).toBe(0);
      server.state.hideReadback = false;
      server.entries.clear();
      expect(await handleHostMessageDurable(state, message, "connection")).toHaveProperty(
        "sessionCommandStartAcknowledged",
      );
      expect(commits).toBe(1);
      expect(await handleHostMessageDurable(state, message, "connection")).toHaveProperty(
        "sessionCommandStartAcknowledged",
      );
      expect(server.entries.get("session")).toHaveLength(1);
      expect(
        await handleHostMessageDurable(state, { ...message, attemptId: "stale" }, "connection"),
      ).toEqual({ ok: true });
      stored = { ...stored, attemptId: "fallback", primaryCommandStartState: "pending" };
      server.state.refuse = true;
      expect(
        await handleHostMessageDurable(state, { ...message, attemptId: "fallback" }, "connection"),
      ).toEqual({ ok: true });
      expect(commits).toBe(1);
      expect(
        await reporting.authorize(session({ reportingRepository: undefined }), "attempt"),
      ).toBe(false);
    } finally {
      await server.close();
    }
  });
});
