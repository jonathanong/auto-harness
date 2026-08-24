import { describe, expect, it, vi } from "vitest";

import {
  releaseLegacyHostAssignment,
  releaseTimedOutHostAssignment,
} from "./plane-storage-host-assignment.ts";

describe("timed-out host assignment cleanup", () => {
  it("returns false for conditional failures and rethrows unexpected failures", async () => {
    const conditional = vi.fn().mockRejectedValue({ name: "ConditionalCheckFailedException" });
    await expect(
      releaseTimedOutHostAssignment(
        {
          doc: { send: conditional },
          tables: { sessions: "Sessions", hostLocks: "Hosts" },
        } as never,
        { sessionId: "sess", attemptId: "attempt", hostId: "host" },
      ),
    ).resolves.toBe(false);

    const unexpected = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      releaseTimedOutHostAssignment(
        {
          doc: { send: unexpected },
          tables: { sessions: "Sessions", hostLocks: "Hosts" },
        } as never,
        { sessionId: "sess", attemptId: "attempt", hostId: "host" },
      ),
    ).rejects.toThrow("boom");
  });

  it("marks a legacy session and decrements its host slot atomically", async () => {
    const send = vi.fn().mockResolvedValue({});
    const opts = {
      sessionId: "sess",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "connection",
    };
    await expect(
      releaseLegacyHostAssignment(
        { doc: { send }, tables: { sessions: "Sessions", hostLocks: "Hosts" } } as never,
        opts,
      ),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toEqual([
      expect.objectContaining({ Update: expect.objectContaining({ TableName: "Sessions" }) }),
      expect.objectContaining({ Update: expect.objectContaining({ TableName: "Hosts" }) }),
    ]);

    send.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
    await expect(
      releaseLegacyHostAssignment(
        { doc: { send }, tables: { sessions: "Sessions", hostLocks: "Hosts" } } as never,
        opts,
      ),
    ).resolves.toBe(false);

    send.mockRejectedValueOnce({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    await expect(
      releaseLegacyHostAssignment(
        { doc: { send }, tables: { sessions: "Sessions", hostLocks: "Hosts" } } as never,
        opts,
      ),
    ).resolves.toBe(false);

    send.mockRejectedValueOnce(new Error("boom"));
    await expect(
      releaseLegacyHostAssignment(
        { doc: { send }, tables: { sessions: "Sessions", hostLocks: "Hosts" } } as never,
        opts,
      ),
    ).rejects.toThrow("boom");
  });
});
