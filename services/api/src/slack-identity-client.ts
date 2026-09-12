import type { SlackBotIdentity, SlackIdentityClient } from "./slack-oauth-types.ts";

const AUTH_TEST_URL = "https://slack.com/api/auth.test";
const SLACK_IDENTITY_TIMEOUT_MS = 10_000;

type SlackIdentityFetcher = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: URLSearchParams;
    signal: AbortSignal;
  },
) => Promise<Pick<Response, "ok" | "json">>;

export type SlackIdentityClientOptions = {
  fetch?: SlackIdentityFetcher;
  /** Tests may lower this; production remains bounded at ten seconds. */
  timeoutMs?: number;
};

/** Create the credential-free transport used by manual Slack configuration. */
export function createSlackIdentityClient(
  options: SlackIdentityClientOptions = {},
): SlackIdentityClient {
  const configuredTimeout = options.timeoutMs;
  const timeoutMs =
    Number.isInteger(configuredTimeout) && configuredTimeout !== undefined && configuredTimeout > 0
      ? configuredTimeout
      : SLACK_IDENTITY_TIMEOUT_MS;
  return {
    async authTestBotToken(botToken): Promise<SlackBotIdentity> {
      const response = await (options.fetch ?? fetch)(AUTH_TEST_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value: unknown = await response.json();
      const parsed = parseBotIdentity(value);
      if (!response.ok || !parsed) throw new Error("Slack bot identity lookup failed");
      return parsed;
    },
  };
}

function parseBotIdentity(value: unknown): SlackBotIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.ok !== true || typeof data.team_id !== "string") return null;
  return {
    workspaceId: data.team_id,
    ...(typeof data.team === "string" ? { workspaceName: data.team } : {}),
    ...(typeof data.api_app_id === "string" ? { appId: data.api_app_id } : {}),
    ...(typeof data.user_id === "string" ? { botUserId: data.user_id } : {}),
  };
}
