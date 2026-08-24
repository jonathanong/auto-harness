import { HOST_PROTOCOL_VERSION, type HostRuntimeReport } from "@auto-harness/shared";

import type { WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

const TEST_RUNTIME: HostRuntimeReport = {
  daemonVersion: "test/seeded",
  gitVersion: "2.36.0",
  gitReady: true,
};

/** Test-only in-process host fixture helpers. Wire registrations fail closed. */
export function testHostRuntime(runtime: HostRuntimeReport | undefined): HostRuntimeReport {
  return runtime ?? TEST_RUNTIME;
}

export function ensureSeededTestHost(state: ControlPlaneState, record: WorktreeRecord): void {
  if (state.hostConnection.has(record.hostId)) return;
  const connectionId = `test-seed:${record.hostId}`;
  state.connections.set(connectionId, {
    connectionId,
    type: "host",
    hostId: record.hostId,
    connectedAt: state.now(),
    lastHeartbeatAt: state.now(),
    capabilities: [],
    repositoryIds: [record.repositoryId],
    runtime: TEST_RUNTIME,
    protocolVersion: HOST_PROTOCOL_VERSION,
  });
  state.hostConnection.set(record.hostId, connectionId);
}
