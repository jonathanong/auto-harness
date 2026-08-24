/** Notification switches shared by the API and the admin settings UI. */
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

/** Redacted Slack configuration returned by the admin-only API. */
export type PublicSlackIntegration = {
  id: "slack";
  type: "slack";
  defaultChannel: string;
  enabled: boolean;
  notifications: SlackNotifications;
  botTokenConfigured: boolean;
  signingSecretConfigured: boolean;
  /** False when config exists but this environment cannot actually send. */
  deliveryAvailable: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};
