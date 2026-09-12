import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it, vi } from "vitest";

import {
  confirmWorkspaceReconnect,
  markWorkspaceReconnectPending,
} from "./plane-storage-reconnect.ts";
import { restoreWorkspaceReconnectPending } from "./plane-storage-reconnect-rollback.ts";

it("fences cancelled workspace reconnect grace with the cancelled status", async () => {
  const send = vi.fn(async () => ({}));
  const ctx = {
    doc: { send } as never,
    tables: {
      hostLocks: "HostLocks",
      sessions: "Sessions",
      workspaceSlots: "WorkspaceSlots",
    } as never,
  };

  await expect(
    markWorkspaceReconnectPending(ctx, {
      sessionId: "session",
      hostId: "host",
      workspaceSlotId: "slot",
      deadlineAt: "2026-09-12T00:00:10.000Z",
      connectionId: "connection",
      expectedStatus: "cancelled",
    }),
  ).resolves.toBe(true);

  expect(send).toHaveBeenCalledWith(expect.any(TransactWriteCommand));
  const command = send.mock.calls[0]![0] as TransactWriteCommand;
  expect(command.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
    ":expectedStatus": "cancelled",
  });

  await expect(
    confirmWorkspaceReconnect(ctx, {
      sessionId: "session",
      hostId: "host",
      workspaceSlotId: "slot",
      deadlineAt: "2026-09-12T00:00:10.000Z",
      connectionId: "replacement",
      expectedStatus: "cancelled",
    }),
  ).resolves.toBe(true);
  const confirmed = send.mock.calls[1]![0] as TransactWriteCommand;
  expect(confirmed.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
    ":expectedStatus": "cancelled",
  });

  await expect(
    restoreWorkspaceReconnectPending(ctx, {
      sessionId: "session",
      hostId: "host",
      workspaceSlotId: "slot",
      connectionId: "replacement",
      expectedStatus: "cancelled",
    }),
  ).resolves.toBe(true);
  const restored = send.mock.calls[2]![0] as TransactWriteCommand;
  expect(restored.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
    ":expectedStatus": "cancelled",
  });
});
