import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { parseGitHubAppConfig, GITHUB_APP_TOKEN_MARGIN_MS } from "./github-app.ts";
import { flushMacrotask, makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

function githubApp() {
  return parseGitHubAppConfig(
    {
      appId: "1",
      privateKeyPath: "/keys/app.pem",
      botLogin: "auto-harness[bot]",
      botUserId: 2,
      repositories: { demo: { installationId: 3, repositoryId: 4 } },
    },
    () => pem,
  );
}

function terminalHandoff(handoffId: string) {
  return {
    type: "session:terminal-hook" as const,
    handoffId,
    sessionId: `session-${handoffId}`,
    repositoryId: "demo",
    worktreeId: "wt-1",
    status: "failed" as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } satisfies Extract<HostWireMessage, { type: "session:terminal-hook" }>;
}

type HandoffInternals = {
  serverProtocolVersion: number;
  pendingTerminalHookHandoffs: Map<string, { complete: boolean; result?: unknown }>;
  handleTerminalHookHandoff(
    message: Extract<HostWireMessage, { type: "session:terminal-hook" }>,
  ): Promise<void>;
  reconcilePendingTerminalStatusForHandoff(sessionId: string): Promise<{ matched: boolean }>;
  runTerminalHookForClaim(message: object, claim: object, expiresAtMs: number): Promise<unknown>;
};

describe("DaemonLoop recovery branch coverage", () => {
  it("abandons a stale handoff after reconciliation replaced its map entry", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport });
      const internals = loop as unknown as HandoffInternals;
      internals.serverProtocolVersion = 7;
      internals.reconcilePendingTerminalStatusForHandoff = async () => {
        internals.pendingTerminalHookHandoffs.delete("stale");
        return { matched: false };
      };

      await internals.handleTerminalHookHandoff(terminalHandoff("stale"));
      expect(internals.pendingTerminalHookHandoffs.has("stale")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("sends completion when a concurrent acknowledgement completes the handoff", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      const internals = loop as unknown as HandoffInternals;
      internals.serverProtocolVersion = 7;
      internals.reconcilePendingTerminalStatusForHandoff = async (sessionId) => {
        const pending = internals.pendingTerminalHookHandoffs.get(`complete`);
        expect(sessionId).toBe("session-complete");
        expect(pending).toBeDefined();
        pending!.complete = true;
        return { matched: false };
      };

      await internals.handleTerminalHookHandoff(terminalHandoff("complete"));
      await flushMacrotask();
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "session-complete",
        handoffId: "complete",
        result: { summary: "Session failed", summarySource: "harness" },
      });
    } finally {
      cleanup();
    }
  });

  it("fails closed when a mapped recovery token is too close to expiry", async () => {
    const { config, cleanup } = await makeRepo();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token: "ghs_near-expiry",
              expires_at: new Date(Date.now() + GITHUB_APP_TOKEN_MARGIN_MS - 1).toISOString(),
              permissions: {
                contents: "write",
                pull_requests: "write",
                issues: "write",
                metadata: "read",
              },
              repositories: [{ id: 4 }],
            }),
            { status: 201 },
          ),
      ),
    );
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
        githubApp: githubApp(),
        processRunner: { run: vi.fn(async () => ({ exitCode: 0 })) },
      });
      const result = await (loop as unknown as HandoffInternals).runTerminalHookForClaim(
        terminalHandoff("near-expiry"),
        {
          currentHookTarget: async () => ({
            cwd: config.repositories[0]!.path,
            repository: config.repositories[0]!,
          }),
        },
        Date.now() + 10_000,
      );
      expect(result).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });

  it("rethrows an unmapped retained-claim failure", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
      });
      await expect(
        (loop as unknown as HandoffInternals).runTerminalHookForClaim(
          { ...terminalHandoff("unmapped"), repositoryId: "other" },
          {
            currentHookTarget: async () => ({
              cwd: config.repositories[0]!.path,
              repository: {
                terminalHookScript: config.repositories[0]!.terminalHookScript,
              },
              get allowedRoots(): readonly string[] {
                throw new Error("retained claim policy became unreadable");
              },
            }),
          },
          Date.now() + 10_000,
        ),
      ).rejects.toThrow("retained claim policy became unreadable");
    } finally {
      cleanup();
    }
  });
});
