/** Notification switches shared by the API and the admin settings UI. */
export type SlackNotifications = {
  onSessionCreated: boolean;
  onSessionStarted: boolean;
  onSessionCompleted: boolean;
  onSessionFailed: boolean;
  onSessionCancelled: boolean;
  onScheduleCompleted: boolean;
  onHostOffline: boolean;
};

export const DEFAULT_SLACK_NOTIFICATIONS: SlackNotifications = {
  onSessionCreated: true,
  onSessionStarted: true,
  onSessionCompleted: true,
  onSessionFailed: true,
  onSessionCancelled: true,
  onScheduleCompleted: false,
  onHostOffline: true,
};

export function normalizeSlackNotifications(
  value: Partial<SlackNotifications> | undefined,
): SlackNotifications {
  return { ...DEFAULT_SLACK_NOTIFICATIONS, ...value };
}

/** Redacted Slack configuration returned by the admin-only API. */
export type PublicSlackIntegration = {
  id: "slack";
  type: "slack";
  defaultChannel: string;
  enabled: boolean;
  notifications: SlackNotifications;
  botTokenConfigured: boolean;
  signingSecretConfigured: boolean;
  /** Legacy rows are treated as manually configured. */
  installationMethod: "manual" | "oauth";
  /** Installation metadata; credentials never appear in this response. */
  installationId?: string;
  workspaceId?: string;
  workspaceName?: string;
  appId?: string;
  botUserId?: string;
  grantedScopes?: string[];
  /** Whether this installation has credentials for signed inbound Slack events. */
  inboundAvailable: boolean;
  /** False when config exists but this environment cannot actually send. */
  deliveryAvailable: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};
