import {
  DEFAULT_SLACK_NOTIFICATIONS,
  type PublicSlackIntegration,
  type SlackNotifications,
} from "@auto-harness/shared";

export type { PublicSlackIntegration, SlackNotifications } from "@auto-harness/shared";
export { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

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
];

export function validateSlackForm(values: SlackFormValues): string | null {
  const botToken = values.botToken.trim();
  if (!botToken) return "Bot token is required. It is never prefilled.";
  if (!/^xoxb-[A-Za-z0-9-]{10,}$/.test(botToken)) {
    return "Bot token must be a valid Slack bot token starting with xoxb-.";
  }
  const channel = values.defaultChannel.trim();
  if (!channel) return "Default channel is required.";
  if (!/^#[a-z0-9][a-z0-9_-]{0,79}$/.test(channel) && !/^[CGD][A-Z0-9]{8,}$/.test(channel)) {
    return "Default channel must be a channel name such as #harness or a channel ID such as C0123ABCDE.";
  }
  if (values.signingSecret && !/^[a-fA-F0-9]{32,128}$/.test(values.signingSecret)) {
    return "Signing secret must contain 32–128 hexadecimal characters.";
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

export function slackDeliveryWarning(config?: PublicSlackIntegration): string | null {
  if (config?.deliveryAvailable) return null;
  if (config) {
    return "Slack is configured but delivery is unavailable. Lifecycle messages are not sent until this environment can decrypt the bot token and run the outbound worker.";
  }
  return "Configuration is stored encrypted. Messages are sent only when outbound delivery is available in this environment.";
}

export function slackSaveSuccessMessage(config: PublicSlackIntegration): string {
  return config.deliveryAvailable
    ? "Slack configuration saved. Lifecycle messages will be delivered to the configured channel."
    : "Slack configuration saved. Slack is configured but delivery is unavailable.";
}

export function initialSlackFormValues(config?: PublicSlackIntegration): SlackFormValues {
  return {
    botToken: "",
    signingSecret: "",
    defaultChannel: config?.defaultChannel ?? "#harness",
    enabled: config?.enabled ?? true,
    notifications: config?.notifications ?? { ...DEFAULT_SLACK_NOTIFICATIONS },
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
