import type { HostInventoryRecord, RepositoryRecord } from "./db/plane-storage.ts";
import { ControlPlaneCatalog } from "./control-plane-catalog-ext.ts";
import * as agentHosts from "./control-plane-agent-hosts.ts";
import * as repos from "./control-plane-repos.ts";
import * as schedules from "./control-plane-schedules.ts";

/**
 * Durable repository, schedule, and host-inventory management delegates.
 * This extension keeps the primary facade below the per-file size limit.
 */
export class ControlPlaneManagement extends ControlPlaneCatalog {
  async putScheduleDurable(
    input: Parameters<typeof schedules.putSchedule>[1],
  ): Promise<ReturnType<typeof schedules.putSchedule>> {
    return schedules.putScheduleDurable(this.state, input);
  }

  updateSchedule(
    id: string,
    patch: Parameters<typeof schedules.updateSchedule>[2],
  ): ReturnType<typeof schedules.updateSchedule> {
    return schedules.updateSchedule(this.state, id, patch);
  }

  async updateScheduleDurable(
    id: string,
    patch: Parameters<typeof schedules.updateSchedule>[2],
  ): Promise<ReturnType<typeof schedules.updateSchedule>> {
    return schedules.updateScheduleDurable(this.state, id, patch);
  }

  deleteSchedule(id: string): ReturnType<typeof schedules.deleteSchedule> {
    return schedules.deleteSchedule(this.state, id);
  }

  async deleteScheduleDurable(id: string): Promise<ReturnType<typeof schedules.deleteSchedule>> {
    return schedules.deleteScheduleDurable(this.state, id);
  }

  createRepository(
    input: Parameters<typeof repos.createRepository>[1],
  ): ReturnType<typeof repos.createRepository> {
    return repos.createRepository(this.state, input);
  }

  async createRepositoryDurable(
    input: Parameters<typeof repos.createRepository>[1],
  ): Promise<ReturnType<typeof repos.createRepository>> {
    return repos.createRepositoryDurable(this.state, input);
  }

  getRepository(id: string): RepositoryRecord | null {
    return repos.getRepository(this.state, id);
  }

  listRepositories(): RepositoryRecord[] {
    return repos.listRepositories(this.state);
  }

  updateRepository(
    id: string,
    patch: Parameters<typeof repos.updateRepository>[2],
  ): ReturnType<typeof repos.updateRepository> {
    return repos.updateRepository(this.state, id, patch);
  }

  async updateRepositoryDurable(
    id: string,
    patch: Parameters<typeof repos.updateRepository>[2],
  ): Promise<ReturnType<typeof repos.updateRepository>> {
    return repos.updateRepositoryDurable(this.state, id, patch);
  }

  deleteRepository(id: string): ReturnType<typeof repos.deleteRepository> {
    return repos.deleteRepository(this.state, id);
  }

  async deleteRepositoryDurable(id: string): Promise<ReturnType<typeof repos.deleteRepository>> {
    return repos.deleteRepositoryDurable(this.state, id);
  }

  putHostInventory(
    hostId: string,
    body: unknown,
  ): { ok: true; config: HostInventoryRecord } | { ok: false; error: string } {
    return agentHosts.putHostInventory(this.state, hostId, body);
  }

  async putHostInventoryDurable(
    hostId: string,
    body: unknown,
  ): Promise<ReturnType<typeof agentHosts.putHostInventory>> {
    return agentHosts.putHostInventoryDurable(this.state, hostId, body);
  }

  getHostInventory(hostId: string): HostInventoryRecord | null {
    return agentHosts.getHostInventory(this.state, hostId);
  }

  listHostInventories(): HostInventoryRecord[] {
    return agentHosts.listHostInventories(this.state);
  }

  deleteHostInventory(hostId: string): ReturnType<typeof agentHosts.deleteHostInventory> {
    return agentHosts.deleteHostInventory(this.state, hostId);
  }

  async deleteHostInventoryDurable(
    hostId: string,
  ): Promise<ReturnType<typeof agentHosts.deleteHostInventory>> {
    return agentHosts.deleteHostInventoryDurable(this.state, hostId);
  }
}
