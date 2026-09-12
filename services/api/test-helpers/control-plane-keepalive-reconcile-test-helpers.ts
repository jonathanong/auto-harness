import type { createControlPlaneState } from "../src/control-plane-state.ts";

export const NOW = "2026-01-01T00:00:00.000Z";

export function connectionRecord() {
  return {
    connectionId: "c",
    type: "host" as const,
    hostId: "h",
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    commandProfiles: [],
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    protocolVersion: 1,
  };
}

export function seedConnectedHost(state: ReturnType<typeof createControlPlaneState>): void {
  state.hostConnection.set("h", "c");
  state.connections.set("c", connectionRecord());
}

export function runningSessionFixture() {
  return { id: "s", hostId: "h", worktreeId: "w", status: "running", attemptId: "a" };
}

export function busyWorktreeFixture() {
  return { id: "w", hostId: "h", status: "busy", currentSessionId: "s" };
}
