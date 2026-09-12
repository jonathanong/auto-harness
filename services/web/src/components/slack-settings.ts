import {
  normalizeSlackNotifications,
  type PublicSlackIntegration as SharedPublicSlackIntegration,
  type SlackNotifications,
} from "@auto-harness/shared";

export type { SlackNotifications } from "@auto-harness/shared";
export { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

/** Public installation metadata is deliberately optional for legacy records. */
type SlackInstallationMetadata = {
  installationMethod?: "manual" | "oauth";
  workspaceId?: string;
  workspaceName?: string;
  appId?: string;
  botUserId?: string;
  grantedScopes?: string[];
  inboundAvailable?: boolean;
};

export type SlackIntegration = Omit<
  SharedPublicSlackIntegration,
  "installationMethod" | "inboundAvailable" | "grantedScopes"
> &
  SlackInstallationMetadata;

/** Web compatibility type: pre-OAuth API responses may omit new metadata. */
export type PublicSlackIntegration = SlackIntegration;

export type SlackFormValues = {
  botToken: string;
  signingSecret: string;
  defaultChannel: string;
  enabled: boolean;
  notifications: SlackNotifications;
};

export const notificationFields: Array<{ key: keyof SlackNotifications; label: string }> = [
  { key: "onSessionCreated", label: "Session Created" },
  { key: "onSessionStarted", label: "Session Started" },
  { key: "onSessionCompleted", label: "Session Completed" },
  { key: "onSessionFailed", label: "Session Failed" },
  { key: "onSessionCancelled", label: "Session Cancelled" },
  { key: "onScheduleCompleted", label: "Schedule Completed" },
  { key: "onHostOffline", label: "Host Offline" },
];

export function validateSlackForm(values: SlackFormValues): string | null {
  const botToken = values.botToken.trim();
  if (!botToken) return "Bot token is required. It is never prefilled.";
  if (!/^xoxb-[A-Za-z0-9-]{10,}$/.test(botToken)) {
    return "Bot token must be a valid Slack bot token starting with xoxb-.";
  }
  const secretError = validateSlackSettings(values);
  if (secretError) return secretError;
  if (values.signingSecret && !/^[\x21-\x7e]{16,128}$/.test(values.signingSecret)) {
    return "Signing secret must contain 16 to 128 non-space visible characters.";
  }
  return null;
}

export function validateSlackSettings(
  values: Pick<SlackFormValues, "defaultChannel">,
): string | null {
  const channel = values.defaultChannel.trim();
  if (!channel) return "Default channel is required.";
  if (!/^#[a-z0-9][a-z0-9_-]{0,79}$/.test(channel) && !/^[CGD][A-Z0-9]{8,}$/.test(channel)) {
    return "Default channel must be a channel name such as #harness or a channel ID such as C0123ABCDE.";
  }
  return null;
}

export function buildSlackConfigBody(values: SlackFormValues): Record<string, unknown> {
  return {
    botToken: values.botToken.trim(),
    ...(values.signingSecret ? { signingSecret: values.signingSecret } : {}),
    defaultChannel: values.defaultChannel.trim(),
    enabled: values.enabled,
    notifications: { ...values.notifications },
  };
}

export function buildSlackSettingsBody(
  values: SlackFormValues,
  expectedVersion: number,
): Record<string, unknown> {
  return {
    expectedVersion,
    defaultChannel: values.defaultChannel.trim(),
    enabled: values.enabled,
    notifications: { ...values.notifications },
  };
}

export function slackInstallationMethod(config?: SlackIntegration): "manual" | "oauth" {
  return config?.installationMethod === "oauth" ? "oauth" : "manual";
}

export function slackOAuthSettings(config?: SlackIntegration): Record<string, unknown> {
  const values = initialSlackFormValues(config);
  return {
    expectedVersion: typeof config?.version === "number" ? config.version : null,
    ...(typeof config?.installationId === "string"
      ? { expectedInstallationId: config.installationId }
      : {}),
    defaultChannel: values.defaultChannel.trim(),
    enabled: values.enabled,
    notifications: { ...values.notifications },
  };
}

export function slackDeliveryWarning(config?: SlackIntegration): string | null {
  if (!config) {
    return "Configuration is stored encrypted. Messages are sent only when outbound delivery is available in this environment.";
  }
  if (!config.enabled) {
    return "Slack is disabled. Lifecycle messages are not sent until the integration is enabled.";
  }
  if (config.deliveryAvailable) return null;
  return "Slack is configured but delivery is unavailable. Lifecycle messages are not sent until this environment can decrypt the bot token and run the outbound worker.";
}

export function slackSaveSuccessMessage(config: SlackIntegration): string {
  if (!config.enabled) {
    return "Slack configuration saved. The integration is disabled; lifecycle messages will not be delivered until it is enabled.";
  }
  return config.deliveryAvailable
    ? "Slack configuration saved. Lifecycle messages will be delivered to the configured channel."
    : "Slack configuration saved. Slack is configured but delivery is unavailable.";
}

export function initialSlackFormValues(config?: SlackIntegration): SlackFormValues {
  return {
    botToken: "",
    signingSecret: "",
    defaultChannel: config?.defaultChannel ?? "#harness",
    enabled: config?.enabled ?? true,
    notifications: normalizeSlackNotifications(config?.notifications),
  };
}

export async function responseMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string" && body.error.message.length < 240) {
      return body.error.message;
    }
  } catch {
    // Keep the UI error generic if the server does not return JSON.
  }
  return `Slack configuration request failed (${response.status}).`;
}
