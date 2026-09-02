/* eslint-disable max-lines -- storage facade methods share one persistence boundary. */

import {
  type CommandRecord,
  type ProviderAccountRecord,
  type ProviderRecord,
} from "./plane-storage-types.ts";
import * as catalog from "./plane-storage-catalog-providers.ts";
import * as providerAccounts from "./plane-storage-provider-accounts.ts";
import * as providerAccountUpdates from "./plane-storage-provider-account-updates.ts";
import * as audit from "./plane-storage-audit.ts";
import * as rateLimits from "./plane-storage-rate-limits.ts";
import * as integrations from "./plane-storage-integrations.ts";
import * as locks from "./plane-storage-locks.ts";
import * as cancelRedeliveries from "./plane-storage-cancel-redeliveries.ts";
import * as notificationDeliveries from "./plane-storage-notification-deliveries.ts";
import * as webhookOutbox from "./plane-storage-webhook-outbox.ts";
import * as webhookSettlement from "./plane-storage-webhook-settlement.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import { clearAll as clearAllStorage } from "./plane-storage-clear.ts";

export type {
  AuthAccountRecord,
  HostInventoryRecord,
  CommandRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
  SessionDrainRecord,
} from "./plane-storage-types.ts";
export {
  isSessionDrainLedgerUnavailable,
  isSessionDrainScopeUnavailable,
} from "./plane-storage-session-drains.ts";

/**
 * DynamoDB persistence for the control plane (DynamoDB Local or AWS).
 * Conditional writes implement exclusive claim and agent register uniqueness.
 */
export class DynamoPlaneStorage extends DynamoPlaneStorageBase {
  /** Marker prevents arbitrary test/storage doubles from being treated as durable rate storage. */
  readonly rateLimitStore = true;

  enqueue(record: import("../slack-delivery-types.ts").SlackDeliveryRecord) {
    return notificationDeliveries.enqueue(this.ctx, record);
  }

  enqueueHostOfflineAlertCandidate(
    candidate: locks.HostOfflineAlertCandidate,
    delivery: import("../slack-delivery-types.ts").SlackDeliveryRecord,
  ) {
    return locks.enqueueHostOfflineAlertCandidate(this.ctx, candidate, delivery);
  }

  claimDue(
    input: Parameters<import("../slack-delivery-types.ts").SlackOutboxStore["claimDue"]>[0],
  ) {
    return notificationDeliveries.claimDue(this.ctx, input);
  }

  get(id: string) {
    return notificationDeliveries.get(this.ctx, id);
  }

  complete(
    input: Parameters<import("../slack-delivery-types.ts").SlackOutboxStore["complete"]>[0],
  ) {
    return notificationDeliveries.complete(this.ctx, input);
  }

  reschedule(
    input: Parameters<import("../slack-delivery-types.ts").SlackOutboxStore["reschedule"]>[0],
  ) {
    return notificationDeliveries.reschedule(this.ctx, input);
  }

  enqueueWebhookDelivery(input: import("../webhook-outbox.ts").WebhookEnqueueInput): Promise<{
    created: boolean;
    delivery: import("../webhook-outbox.ts").DurableWebhookDelivery;
  }> {
    return webhookOutbox.enqueueWebhookDelivery(this.ctx, input);
  }

  getWebhookDelivery(
    id: string,
  ): Promise<import("../webhook-outbox.ts").DurableWebhookDelivery | null> {
    return webhookOutbox.getWebhookDelivery(this.ctx, id);
  }

  listDueWebhookDeliveries(input: {
    state: "pending" | "leased";
    now: string;
    limit: number;
  }): Promise<import("../webhook-outbox.ts").DurableWebhookDelivery[]> {
    return webhookOutbox.listDueWebhookDeliveries(this.ctx, input);
  }

  claimWebhookDelivery(
    input: webhookOutbox.WebhookLeaseInput,
  ): Promise<import("../webhook-outbox.ts").DurableWebhookDelivery | null> {
    return webhookOutbox.claimWebhookDelivery(this.ctx, input);
  }

  completeWebhookDelivery(input: webhookOutbox.WebhookLeaseFence): Promise<boolean> {
    return webhookSettlement.completeWebhookDelivery(this.ctx, input);
  }

  failWebhookDelivery(
    input: webhookOutbox.WebhookLeaseFence & {
      failureCode: import("../webhook-outbox.ts").WebhookFailureCode;
      nextAttemptAt: string;
    },
  ): Promise<"pending" | "dead" | null> {
    return webhookSettlement.failWebhookDelivery(this.ctx, input);
  }

  deadLetterExhaustedWebhookDelivery(input: { id: string; now: string }): Promise<boolean> {
    return webhookSettlement.deadLetterExhaustedWebhookDelivery(this.ctx, input);
  }

  recordPendingCancelRedelivery(input: {
    sessionId: string;
    hostId: string;
    attemptId: string;
    now: string;
  }): Promise<void> {
    return cancelRedeliveries.recordPendingCancelRedelivery(this.ctx, input);
  }

  listPendingCancelRedeliveries(
    limit: number,
  ): Promise<cancelRedeliveries.CancelRedeliveryRecord[]> {
    return cancelRedeliveries.listPendingCancelRedeliveries(this.ctx, limit);
  }

  claimCancelRedeliveryAttempt(
    sessionId: string,
    now: string,
    maxAttempts: number,
  ): Promise<boolean> {
    return cancelRedeliveries.claimCancelRedeliveryAttempt(this.ctx, sessionId, now, maxAttempts);
  }

  clearPendingCancelRedelivery(sessionId: string): Promise<void> {
    return cancelRedeliveries.clearPendingCancelRedelivery(this.ctx, sessionId);
  }

  getSlackIntegration(): Promise<
    import("../slack-integration-types.ts").SlackIntegrationRecord | null
  > {
    return integrations.getSlackIntegration(this.ctx);
  }

  putSlackIntegration(
    record: import("../slack-integration-types.ts").SlackIntegrationRecord,
    expectedVersion: number | null,
  ): Promise<boolean> {
    return integrations.putSlackIntegration(this.ctx, record, expectedVersion);
  }

  deleteSlackIntegration(expectedVersion: number): Promise<boolean> {
    return integrations.deleteSlackIntegration(this.ctx, expectedVersion);
  }

  putAuditLog(record: import("../audit-types.ts").AuditLogRecord): Promise<void> {
    return audit.putAuditLog(this.ctx, record);
  }

  listAuditLogs(
    query?: import("../audit-types.ts").AuditLogListQuery,
  ): Promise<import("../audit-types.ts").AuditLogPage> {
    return audit.listAuditLogs(this.ctx, query);
  }

  listAllAuditLogs(): Promise<import("../audit-types.ts").AuditLogRecord[]> {
    return audit.listAllAuditLogs(this.ctx);
  }

  consumeRateLimit(
    input: rateLimits.DurableRateLimitInput,
  ): Promise<import("../rate-limit.ts").RateLimitDecision> {
    return rateLimits.consumeRateLimit(this.ctx, input);
  }

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
    expectedMaxConcurrentSessions?: number;
    updatedAt: string;
    patch: Partial<
      Pick<
        ProviderAccountRecord,
        | "providerId"
        | "label"
        | "usageLimitCooldownSeconds"
        | "usageLimitedUntil"
        | "maxConcurrentSessions"
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
