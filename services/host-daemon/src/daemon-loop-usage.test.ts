import { describe, expect, it } from "vitest";

import { DaemonLoop } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";

describe("DaemonLoop session usage", () => {
  it("forwards terminal CLI usage in the daemon status report", async () => {
    const { config, cleanup } = await makeRepo();
    const sent: unknown[] = [];
    try {
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      const internals = loop as unknown as {
        runner: { run(): Promise<unknown> };
      };
      internals.runner = {
        async run() {
          return {
            status: "completed",
            exitCode: 0,
            logs: [],
            usage: {
              kind: "delta",
              sequence: 1,
              inputTokens: "2",
              observedAt: "2026-01-01T00:00:00.000Z",
              source: "cli",
            },
          };
        },
      };
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "usage",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: "session:status",
          usage: expect.objectContaining({ inputTokens: "2" }),
        }),
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
