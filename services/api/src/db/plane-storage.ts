import {
  type CommandRecord,
  type ProviderAccountRecord,
  type ProviderRecord,
} from "./plane-storage-types.ts";
import * as catalog from "./plane-storage-catalog-providers.ts";
import * as providerAccounts from "./plane-storage-provider-accounts.ts";
import * as providerAccountUpdates from "./plane-storage-provider-account-updates.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import { clearAll as clearAllStorage } from "./plane-storage-clear.ts";

export type {
  AuthAccountRecord,
  HostInventoryRecord,
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
  putProvider(
    rec: ProviderRecord,
    markers?: readonly import("./plane-storage-deletion-markers.ts").DeletionMarker[],
  ): Promise<void> {
    return catalog.putProvider(this.ctx, rec, markers);
  }

  getProvider(id: string): Promise<ProviderRecord | null> {
    return catalog.getProvider(this.ctx, id);
  }

  listProviders(): Promise<ProviderRecord[]> {
    return catalog.listProviders(this.ctx);
  }

  deleteProvider(
    id: string,
    markers?: readonly import("./plane-storage-deletion-markers.ts").OwnedDeletionMarker[],
  ): Promise<boolean> {
    return catalog.deleteProvider(this.ctx, id, markers);
  }

  putProviderAccount(rec: ProviderAccountRecord): Promise<boolean> {
    return providerAccounts.putProviderAccount(this.ctx, rec);
  }

  updateProviderAccount(opts: {
    id: string;
    expectedVersion: number;
    expectedProviderId?: string;
    updatedAt: string;
    patch: Partial<
      Pick<
        ProviderAccountRecord,
        "providerId" | "label" | "usageLimitCooldownSeconds" | "usageLimitedUntil"
      >
    >;
  }): Promise<boolean> {
    return providerAccountUpdates.updateProviderAccount(this.ctx, opts);
  }

  clearProviderAccountUsageLimit(opts: {
    id: string;
    expectedVersion: number;
    expectedUsageLimitedUntil?: string | null;
    updatedAt: string;
  }): Promise<boolean> {
    return providerAccountUpdates.clearProviderAccountUsageLimit(this.ctx, opts);
  }

  getProviderAccount(id: string): Promise<ProviderAccountRecord | null> {
    return providerAccounts.getProviderAccount(this.ctx, id);
  }

  listProviderAccounts(): Promise<ProviderAccountRecord[]> {
    return providerAccounts.listProviderAccounts(this.ctx);
  }

  deleteProviderAccount(
    id: string,
    markers?: readonly import("./plane-storage-deletion-markers.ts").OwnedDeletionMarker[],
  ): Promise<boolean> {
    return providerAccounts.deleteProviderAccount(this.ctx, id, markers);
  }

  putCommand(
    rec: CommandRecord,
    markers?: readonly import("./plane-storage-deletion-markers.ts").DeletionMarker[],
  ): Promise<void> {
    return catalog.putCommand(this.ctx, rec, markers);
  }

  getCommand(id: string): Promise<CommandRecord | null> {
    return catalog.getCommand(this.ctx, id);
  }

  listCommands(): Promise<CommandRecord[]> {
    return catalog.listCommands(this.ctx);
  }

  deleteCommand(
    id: string,
    markers?: readonly import("./plane-storage-deletion-markers.ts").OwnedDeletionMarker[],
  ): Promise<void> {
    return catalog.deleteCommand(this.ctx, id, markers);
  }

  clearAll(): Promise<void> {
    return clearAllStorage(this.ctx);
  }
}
