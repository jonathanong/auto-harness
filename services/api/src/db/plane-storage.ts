import {
  type CommandRecord,
  type ProviderAccountRecord,
  type ProviderRecord,
} from "./plane-storage-types.ts";
import * as catalog from "./plane-storage-catalog-providers.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import { clearAll as clearAllStorage } from "./plane-storage-clear.ts";

export type {
  AgentHostRecord,
  CommandRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./plane-storage-types.ts";

/**
 * DynamoDB persistence for the control plane (DynamoDB Local or AWS).
 * Conditional writes implement exclusive claim and agent register uniqueness.
 */
export class DynamoPlaneStorage extends DynamoPlaneStorageBase {
  putProvider(rec: ProviderRecord): Promise<void> {
    return catalog.putProvider(this.ctx, rec);
  }

  getProvider(id: string): Promise<ProviderRecord | null> {
    return catalog.getProvider(this.ctx, id);
  }

  listProviders(): Promise<ProviderRecord[]> {
    return catalog.listProviders(this.ctx);
  }

  deleteProvider(id: string): Promise<void> {
    return catalog.deleteProvider(this.ctx, id);
  }

  putProviderAccount(rec: ProviderAccountRecord): Promise<void> {
    return catalog.putProviderAccount(this.ctx, rec);
  }

  getProviderAccount(id: string): Promise<ProviderAccountRecord | null> {
    return catalog.getProviderAccount(this.ctx, id);
  }

  listProviderAccounts(): Promise<ProviderAccountRecord[]> {
    return catalog.listProviderAccounts(this.ctx);
  }

  deleteProviderAccount(id: string): Promise<void> {
    return catalog.deleteProviderAccount(this.ctx, id);
  }

  putCommand(rec: CommandRecord): Promise<void> {
    return catalog.putCommand(this.ctx, rec);
  }

  getCommand(id: string): Promise<CommandRecord | null> {
    return catalog.getCommand(this.ctx, id);
  }

  listCommands(): Promise<CommandRecord[]> {
    return catalog.listCommands(this.ctx);
  }

  deleteCommand(id: string): Promise<void> {
    return catalog.deleteCommand(this.ctx, id);
  }

  clearAll(): Promise<void> {
    return clearAllStorage(this.ctx);
  }
}
