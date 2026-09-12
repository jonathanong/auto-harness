import type { SlackNotifications } from "@auto-harness/shared";

import type { AuditActor } from "./audit-types.ts";

/** Credentials are injected at runtime and are never persisted or exposed. */
export type SlackAppCredentials = {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
};

/** Bounded Slack API boundary used to identify manually supplied bot tokens. */
export type SlackIdentityClient = {
  authTestBotToken(botToken: string): Promise<SlackBotIdentity>;
};

export type SlackOAuthClient = {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<SlackOAuthExchange>;
  /**
   * Disposes of a newly-issued bot token when Auto Harness cannot durably own
   * the installation. Implementations must bound this network operation.
   */
  revokeBotToken(botToken: string): Promise<void>;
  /**
   * Identifies a manually supplied bot token before enabling event ingress.
   * Implementations must bound this network operation.
   */
  authTestBotToken?(botToken: string): Promise<SlackBotIdentity>;
};

/** Non-secret identity returned by Slack's bounded auth.test endpoint. */
export type SlackBotIdentity = {
  workspaceId: string;
  workspaceName?: string;
  /** A response without this cannot enable manually configured inbound events. */
  appId?: string;
  botUserId?: string;
};

export type SlackOAuthExchange = {
  botToken: string;
  workspaceId: string;
  workspaceName?: string;
  appId: string;
  botUserId?: string;
  scopes: string[];
};

export type SlackOAuthStateRecord = {
  stateHash: string;
  /**
   * The deployed public origin selected when this one-time flow started. It
   * keeps Slack's code exchange and browser return redirect bound to the same
   * callback URL even when another warm Lambda has not yet read SSM.
   */
  publicBaseUrl: string;
  principalId: string;
  /** Snapshot the authenticated initiator for public-callback audit attribution. */
  actor?: AuditActor;
  expectedVersion: number | null;
  /** New states bind reconnects to the non-reusable installation identity. */
  expectedInstallationId?: string | null;
  defaultChannel: string;
  enabled: boolean;
  notifications: SlackNotifications;
  expiresAt: number;
};

export type SlackInboundEventRecord = {
  workspaceId: string;
  /** Slack's signed envelope `api_app_id`, retained for OAuth installation fencing. */
  apiAppId?: string;
  /** Slack's signed envelope authorizations, retained for manual bot fencing. */
  authorizedUserIds?: string[];
  eventId: string;
  type: "app_mention" | "message.im";
  channelId: string;
  userId: string;
  text: string;
  eventTs: string;
  receivedAt: string;
  status: "pending";
  dueOrder: string;
  ttl: number;
};
