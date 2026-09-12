import type {
  SlackAppCredentials,
  SlackOAuthClient,
  SlackOAuthExchange,
} from "./slack-oauth-types.ts";
import { createSlackIdentityClient } from "./slack-identity-client.ts";
import type { SlackIdentityClientOptions } from "./slack-identity-client.ts";

const TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const REVOKE_URL = "https://slack.com/api/auth.revoke";
const SLACK_OAUTH_TIMEOUT_MS = 10_000;

type SlackOAuthFetcher = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: URLSearchParams;
    signal: AbortSignal;
  },
) => Promise<Pick<Response, "ok" | "json">>;

type SlackOAuthClientOptions = {
  fetch?: SlackOAuthFetcher;
  /** Tests may lower this; production remains bounded at ten seconds. */
  timeoutMs?: number;
};

/** Small transport boundary so OAuth protocol failures do not leak into route responses. */
export function createSlackOAuthClient(
  credentials: SlackAppCredentials,
  options: SlackOAuthClientOptions & SlackIdentityClientOptions = {},
): SlackOAuthClient {
  const configuredTimeout = options.timeoutMs;
  const timeoutMs =
    Number.isInteger(configuredTimeout) && configuredTimeout !== undefined && configuredTimeout > 0
      ? configuredTimeout
      : SLACK_OAUTH_TIMEOUT_MS;
  return {
    async exchangeCode({ code, redirectUri }): Promise<SlackOAuthExchange> {
      const response = await (options.fetch ?? fetch)(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value: unknown = await response.json();
      const parsed = parseExchange(value);
      if (!response.ok || !parsed) throw new Error("Slack OAuth exchange failed");
      return parsed;
    },
    async revokeBotToken(botToken): Promise<void> {
      const response = await (options.fetch ?? fetch)(REVOKE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value: unknown = await response.json();
      if (!response.ok || !revocationSucceeded(value))
        throw new Error("Slack OAuth token revocation failed");
    },
    ...createSlackIdentityClient({ ...options, timeoutMs }),
  };
}

function revocationSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.ok === true && data.revoked === true;
}

function parseExchange(value: unknown): SlackOAuthExchange | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const team = data.team;
  const scope = data.scope;
  if (
    data.ok !== true ||
    typeof data.access_token !== "string" ||
    typeof data.app_id !== "string" ||
    !team ||
    typeof team !== "object" ||
    typeof (team as Record<string, unknown>).id !== "string" ||
    typeof scope !== "string"
  ) {
    return null;
  }
  return {
    botToken: data.access_token,
    workspaceId: (team as { id: string }).id,
    ...(typeof (team as { name?: unknown }).name === "string"
      ? { workspaceName: (team as { name: string }).name }
      : {}),
    appId: data.app_id,
    ...(typeof data.bot_user_id === "string" ? { botUserId: data.bot_user_id } : {}),
    scopes: scope.split(",").filter(Boolean).toSorted(),
  };
}
