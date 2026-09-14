import { describe, expect, it } from "vitest";

import type { DaemonConfig } from "./config-types.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { createLoopbackTransport } from "./loopback-transport.ts";

function minimalConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return { hostId: "host-1", repositories: [], providerAccounts: [], ...overrides };
}

describe("DaemonLoop live log subscribers", () => {
  it("fans local chunks out to subscribers and drops empty listener sets", async () => {
    const loop = new DaemonLoop({
      config: minimalConfig({ apiUrl: "https://example.test", apiKey: "secret" }),
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
    });
    const seen: string[] = [];
    const unsub = loop.subscribeLogs("sess", (chunk) => seen.push(chunk.content));
    const extra = loop.subscribeLogs("sess", () => undefined);
    extra();
    await (
      loop as unknown as {
        emitLog(chunk: {
          sessionId: string;
          attemptId: string;
          stream: "stdout";
          content: string;
          timestamp: string;
          seq: number;
        }): Promise<void>;
      }
    ).emitLog({
      sessionId: "sess",
      attemptId: "a",
      stream: "stdout",
      content: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    expect(seen).toEqual(["hello"]);
    unsub();
    await (loop as unknown as { emitLog(chunk: { sessionId: string }): Promise<void> }).emitLog({
      sessionId: "other",
      attemptId: "a",
      stream: "stdout",
      content: "ignored",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    } as never);
  });
});
