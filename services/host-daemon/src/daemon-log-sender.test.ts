import { describe, expect, it } from "vitest";

import { sendDaemonLog } from "./daemon-log-sender.ts";

const chunk = {
  sessionId: "s",
  attemptId: "a",
  stream: "stdout" as const,
  content: "hello",
  timestamp: "t",
  seq: 2,
};

describe("sendDaemonLog", () => {
  it("forwards logs and mirrors a readable local line", async () => {
    const lines: string[] = [];
    const sent: unknown[] = [];
    const options: unknown[] = [];
    await sendDaemonLog(
      {
        send: async (message: unknown, sendOptions?: unknown) => {
          sent.push(message);
          options.push(sendOptions);
        },
      } as never,
      (line) => lines.push(line),
      chunk,
    );
    expect(lines).toEqual(["[stdout#2] hello"]);
    expect(sent).toEqual([expect.objectContaining({ type: "session:log", sessionId: "s" })]);
    expect(sent[0]).not.toHaveProperty("dropped");
    expect(options).toEqual([undefined]);
  });

  it("forwards source-side drop telemetry as a non-droppable frame", async () => {
    const sent: unknown[] = [];
    const options: unknown[] = [];
    await sendDaemonLog(
      {
        send: async (message: unknown, sendOptions?: unknown) => {
          sent.push(message);
          options.push(sendOptions);
        },
      } as never,
      undefined,
      {
        ...chunk,
        stream: "system",
        dropped: 4,
      },
    );
    expect(sent).toEqual([expect.objectContaining({ type: "session:log", dropped: 4 })]);
    expect(options).toEqual([{ nonDroppable: true }]);
  });

  it("retains lifecycle system frames under outbound pressure", async () => {
    const options: unknown[] = [];
    await sendDaemonLog(
      {
        send: async (_message: unknown, sendOptions?: unknown) => {
          options.push(sendOptions);
        },
      } as never,
      undefined,
      { ...chunk, stream: "system", content: "Session failed at t" },
    );
    expect(options).toEqual([{ nonDroppable: true }]);
  });

  it("does not require a local logger", async () => {
    await expect(
      sendDaemonLog({ send: async () => {} } as never, undefined, chunk),
    ).resolves.toBeUndefined();
  });

  it.each([new Error("offline"), "raw"])(
    "reports failed delivery %p without throwing",
    async (failure) => {
      const lines: string[] = [];
      await sendDaemonLog(
        { send: async () => Promise.reject(failure) } as never,
        (line) => lines.push(line),
        chunk,
      );
      expect(lines.at(-1)).toContain(failure instanceof Error ? "offline" : "raw");
    },
  );
});
