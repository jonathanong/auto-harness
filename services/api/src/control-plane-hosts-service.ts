import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import type { WorktreeRecord } from "./db/types.ts";
import type { HostInventoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import * as agents from "./control-plane-agents.ts";
import * as agentHosts from "./control-plane-agent-hosts.ts";
import * as worktrees from "./control-plane-worktrees.ts";
import * as lifecycle from "./control-plane-lifecycle.ts";
import * as reconnect from "./control-plane-reconnect.ts";
import * as durableCatalog from "./control-plane-durable-read-catalog.ts";
import * as durableRuntime from "./control-plane-durable-read-runtime.ts";
import { ensureSeededTestHost, testHostRuntime } from "./control-plane-test-host.ts";

/** Host registration, inventory, worktrees, and drain/reclaim. */
export class ControlPlaneHostsService {
  readonly state: ControlPlaneState;

  constructor(state: ControlPlaneState) {
    this.state = state;
  }

  getHostConnectionId(hostId: string): string | undefined {
    return this.state.hostConnection.get(hostId);
  }

  getHeartbeatStaleMs(): number {
    return this.state.heartbeatStaleMs;
  }

  getAckDeadlineMs(): number {
    return this.state.ackDeadlineMs;
  }

  seedWorktree(record: WorktreeRecord): void {
    ensureSeededTestHost(this.state, record);
    worktrees.seedWorktree(this.state, record);
  }

  listWorktrees(): WorktreeRecord[] {
    return worktrees.listWorktrees(this.state);
  }

  getWorktree(id: string): WorktreeRecord | null {
    return worktrees.getWorktree(this.state, id);
  }

  listWorktreesDurable(): Promise<WorktreeRecord[]> {
    return durableRuntime.listWorktreesDurable(this.state);
  }

  listHosts(): ReturnType<typeof agents.listHosts> {
    return agents.listHosts(this.state);
  }

  async listHostsDurable(): Promise<ReturnType<typeof agents.listHosts>> {
    await durableRuntime.refreshSchedulerReadModel(this.state);
    await durableRuntime.listWorktreesDurable(this.state);
    return agents.listHosts(this.state);
  }

  registerHost(
    opts: Parameters<typeof agents.registerHost>[1],
  ): { ok: true; connectionId: string } | { ok: false; error: string } {
    return agents.registerHost(this.state, {
      ...opts,
      runtime: testHostRuntime(opts.runtime),
      protocolVersion: opts.protocolVersion ?? HOST_PROTOCOL_VERSION,
    });
  }

  registerHostDurable(
    opts: Parameters<typeof agents.registerHost>[1],
  ): Promise<ReturnType<typeof agents.registerHost>> {
    return agents.registerHostDurable(this.state, {
      ...opts,
      runtime: testHostRuntime(opts.runtime),
      protocolVersion: opts.protocolVersion ?? HOST_PROTOCOL_VERSION,
    });
  }

  disconnectHost(connectionId: string): string[] {
    return agents.disconnectHost(this.state, connectionId);
  }

  disconnectHostDurable(connectionId: string): Promise<string[]> {
    return agents.disconnectHostDurable(this.state, connectionId);
  }

  heartbeat(hostId: string, at?: string): boolean {
    return agents.heartbeat(this.state, hostId, at);
  }

  drainHost(hostId: string): { ok: boolean; runningSessionIds: string[] } {
    return agents.drainHost(this.state, hostId);
  }

  drainHostDurable(hostId: string): Promise<{ ok: boolean; runningSessionIds: string[] }> {
    return agents.drainHostDurable(this.state, hostId);
  }

  isDraining(hostId: string): boolean {
    return agents.isDraining(this.state, hostId);
  }

  reclaimStaleHosts(nowMs: number = Date.now()): string[] {
    return lifecycle.reclaimStaleHosts(this.state, nowMs);
  }

  reclaimStaleHostsDurable(nowMs: number = Date.now()): Promise<string[]> {
    return lifecycle.reclaimStaleHostsDurable(this.state, nowMs);
  }

  reclaimReconnectDeadlines(nowMs: number = Date.now()): Promise<string[]> {
    return reconnect.reclaimReconnectDeadlines(this.state, nowMs);
  }

  putHostInventory(
    hostId: string,
    body: unknown,
    options?: { allowLegacyRelativeTerminalHooks?: boolean },
  ): ReturnType<typeof agentHosts.putHostInventory> {
    return agentHosts.putHostInventory(this.state, hostId, body, options);
  }

  putHostInventoryDurable(
    hostId: string,
    body: unknown,
    options?: {
      allowLegacyRelativeTerminalHooks?: boolean;
      awaitProjection?: boolean;
    },
  ): Promise<ReturnType<typeof agentHosts.putHostInventory>> {
    return agentHosts.putHostInventoryDurable(this.state, hostId, body, options);
  }

  getHostInventory(hostId: string): HostInventoryRecord | null {
    return agentHosts.getHostInventory(this.state, hostId);
  }

  getHostInventoryDurable(hostId: string): Promise<HostInventoryRecord | null> {
    return durableCatalog.getHostInventoryDurable(this.state, hostId);
  }

  listHostInventories(): HostInventoryRecord[] {
    return agentHosts.listHostInventories(this.state);
  }

  async listHostInventoriesDurable(): Promise<HostInventoryRecord[]> {
    await durableCatalog.listHostInventoriesDurable(this.state);
    return agentHosts.listHostInventories(this.state);
  }

  deleteHostInventory(
    hostId: string,
    expectedVersion?: number,
  ): ReturnType<typeof agentHosts.deleteHostInventory> {
    return agentHosts.deleteHostInventory(this.state, hostId, expectedVersion);
  }

  deleteHostInventoryDurable(
    hostId: string,
    expectedVersion?: number,
  ): Promise<ReturnType<typeof agentHosts.deleteHostInventory>> {
    return agentHosts.deleteHostInventoryDurable(this.state, hostId, expectedVersion);
  }
}
