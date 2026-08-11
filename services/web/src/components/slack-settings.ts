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
  { key: "onSessionCreated", label: "Session created" },
  { key: "onSessionStarted", label: "Session started" },
  { key: "onSessionCompleted", label: "Session completed" },
  { key: "onSessionFailed", label: "Session failed" },
  { key: "onSessionCancelled", label: "Session cancelled" },
  { key: "onScheduleCompleted", label: "Schedule completed" },
];

export function validateSlackForm(values: SlackFormValues): string | null {
  if (!values.botToken.trim()) return "Bot token is required. It is never prefilled.";
  if (!values.botToken.startsWith("xoxb-")) return "Bot token must start with xoxb-.";
  if (!values.defaultChannel.trim()) return "Default channel is required.";
  if (
    !/^#[A-Za-z0-9._-]+$/.test(values.defaultChannel.trim()) &&
    !/^C[A-Z0-9]+$/.test(values.defaultChannel.trim())
  ) {
    return "Default channel must be a channel name such as #harness or a channel ID such as C0123ABCDE.";
  }
  return null;
}

export function buildSlackConfigBody(values: SlackFormValues): Record<string, unknown> {
  return {
    botToken: values.botToken,
    ...(values.signingSecret ? { signingSecret: values.signingSecret } : {}),
    defaultChannel: values.defaultChannel.trim(),
    enabled: values.enabled,
    notifications: { ...values.notifications },
  };
}

export function initialSlackFormValues(config?: PublicSlackIntegration): SlackFormValues {
  return {
    botToken: "",
    signingSecret: "",
    defaultChannel: config?.defaultChannel ?? "#harness",
    enabled: config?.enabled ?? true,
    notifications: config?.notifications ?? DEFAULT_SLACK_NOTIFICATIONS,
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
