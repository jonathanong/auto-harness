import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { expect, it } from "vitest";

import { parseHostMessage } from "./ws-hub.ts";

const registration = {
  type: "host:register",
  hostId: "host",
  worktrees: [],
  protocolVersion: HOST_PROTOCOL_VERSION,
  daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
  daemonStartedAt: "2026-08-11T00:00:00.000Z",
  runningAttempts: [],
  runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
};

it("accepts a bounded workspace snapshot and rejects malformed pool or slot collections", () => {
  const snapshot = [
    { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: "/ws" }] },
  ];
  expect(parseHostMessage({ ...registration, workspacePools: snapshot })).toMatchObject({
    workspacePools: snapshot,
  });

  for (const workspacePools of [
    null,
    Array(1_001).fill(snapshot[0]),
    [null],
    [{ workspacePoolId: "pool", slots: null }],
    [{ workspacePoolId: "pool", slots: Array(1_001).fill(snapshot[0]?.slots[0]) }],
    [{ workspacePoolId: "pool", slots: [null] }],
    [snapshot[0], { ...snapshot[0] }],
    [{ workspacePoolId: "pool", slots: [{ id: "slot", name: "", path: "/ws" }] }],
    [{ workspacePoolId: "pool", slots: [snapshot[0]?.slots[0], snapshot[0]?.slots[0]] }],
  ]) {
    expect(parseHostMessage({ ...registration, workspacePools })).toBeNull();
  }
});
