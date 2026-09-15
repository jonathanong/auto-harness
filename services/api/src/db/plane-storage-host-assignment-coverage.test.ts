import { describe, expect, it, vi } from "vitest";

import { releaseTimedOutHostAssignment } from "./plane-storage-host-assignment.ts";

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
});
