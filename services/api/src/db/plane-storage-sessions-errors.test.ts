import { describe, expect, it, vi } from "vitest";

import {
  activeSessionDrainError,
  isCreateSessionConflict,
  isRepositoryAdmissionClosed,
  sessionDrainOperationId,
} from "./plane-storage-sessions-errors.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const session = { id: "session", repositoryId: "repo" } as SessionRecord;

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { sessionDrains: "SessionDrains" } as never,
  } as PlaneStorageCtx;
}

describe("session create admission errors", () => {
  it("classifies conflict names and ignores non-errors", () => {
    expect(isCreateSessionConflict("nope")).toBe(false);
    expect(isCreateSessionConflict(new Error("other"))).toBe(false);
    expect(isRepositoryAdmissionClosed(new Error("nope"))).toBe(false);
    expect(sessionDrainOperationId(new Error("nope"))).toBeNull();
  });

  it("uses an unknown drain id when the session has no principal", async () => {
    const send = vi.fn();
    const error = await activeSessionDrainError(ctx(send), session);
    expect(send).not.toHaveBeenCalled();
    expect(error.operationId).toBe("unknown");
    expect(sessionDrainOperationId(error)).toBe("unknown");
  });

  it("reads the active drain operation when a principal is present", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: { operationId: "drain-1" } });
    const error = await activeSessionDrainError(ctx(send), {
      ...session,
      principalId: "user:alice",
    });
    expect(error.operationId).toBe("drain-1");
    expect(sessionDrainOperationId(error)).toBe("drain-1");
  });
});
