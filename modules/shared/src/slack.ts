export type SlackNotifications = {
  onSessionCreated: boolean;
  onSessionStarted: boolean;
  onSessionCompleted: boolean;
  onSessionFailed: boolean;
  onSessionCancelled: boolean;
  onScheduleCompleted: boolean;
};

export const DEFAULT_SLACK_NOTIFICATIONS: SlackNotifications = {
  onSessionCreated: true,
  onSessionStarted: true,
  onSessionCompleted: true,
  onSessionFailed: true,
  onSessionCancelled: true,
  onScheduleCompleted: false,
};

/** Redacted integration state returned by the admin Slack settings API. */
export type PublicSlackIntegration = {
  id: "slack";
  type: "slack";
  defaultChannel: string;
  enabled: boolean;
  notifications: SlackNotifications;
  botTokenConfigured: boolean;
  signingSecretConfigured: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};
