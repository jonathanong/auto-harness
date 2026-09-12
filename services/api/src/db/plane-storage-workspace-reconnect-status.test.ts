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

it("restores previous workspace reconnect fields and fences unexpected storage failures", async () => {
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
    restoreWorkspaceReconnectPending(ctx, {
      sessionId: "restored",
      hostId: "host",
      workspaceSlotId: "slot",
      connectionId: "replacement",
      previousDeadlineAt: "2026-09-12T00:00:10.000Z",
      previousAssignmentConnectionId: "original",
      previousWorkspaceSlotConnectionId: "original",
    }),
  ).resolves.toBe(true);
  const restored = send.mock.calls[0]![0] as TransactWriteCommand;
  expect(restored.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
    ":previousDeadline": "2026-09-12T00:00:10.000Z",
    ":previousAssignmentConnectionId": "original",
  });
  expect(restored.input.TransactItems?.[2]?.Update?.ExpressionAttributeValues).toMatchObject({
    ":previousWorkspaceSlotConnectionId": "original",
  });

  const failure = new Error("storage unavailable");
  const failing = {
    ...ctx,
    doc: { send: vi.fn(async () => Promise.reject(failure)) } as never,
  };
  await expect(
    restoreWorkspaceReconnectPending(failing, {
      sessionId: "failed-restore",
      hostId: "host",
      workspaceSlotId: "slot",
      connectionId: "connection",
    }),
  ).rejects.toBe(failure);
});

it("rethrows unexpected workspace reconnect storage failures", async () => {
  const failure = new Error("storage unavailable");
  const ctx = {
    doc: { send: vi.fn(async () => Promise.reject(failure)) } as never,
    tables: {
      hostLocks: "HostLocks",
      sessions: "Sessions",
      workspaceSlots: "WorkspaceSlots",
    } as never,
  };

  await expect(
    markWorkspaceReconnectPending(ctx, {
      sessionId: "mark-failure",
      hostId: "host",
      workspaceSlotId: "slot",
      deadlineAt: "2026-09-12T00:00:10.000Z",
      connectionId: "connection",
    }),
  ).rejects.toBe(failure);
  await expect(
    confirmWorkspaceReconnect(ctx, {
      sessionId: "confirm-failure",
      hostId: "host",
      workspaceSlotId: "slot",
      connectionId: "connection",
    }),
  ).rejects.toBe(failure);
});
