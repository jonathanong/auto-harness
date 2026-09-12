import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SlackConfigInput } from "./control-plane-slack.ts";
import type { SlackBotIdentity } from "./slack-oauth-types.ts";

/**
 * A manual configuration remains valid for outbound delivery when Slack cannot
 * identify the token, but event ingress stays disabled without this fence.
 */
export async function resolveManualSlackIdentity(
  state: ControlPlaneState,
  input: SlackConfigInput,
): Promise<SlackBotIdentity | undefined> {
  const authTestBotToken =
    state.slackIdentityClient?.authTestBotToken ?? state.slackOAuthClient?.authTestBotToken;
  if (!input.signingSecret || !authTestBotToken) return undefined;
  try {
    return normalizeManualIdentity(await authTestBotToken(input.botToken));
  } catch {
    return undefined;
  }
}

function normalizeManualIdentity(identity: SlackBotIdentity): SlackBotIdentity | undefined {
  if (
    !/^[A-Z0-9]+$/.test(identity.workspaceId) ||
    !identity.botUserId ||
    !/^U[A-Za-z0-9]{1,63}$/.test(identity.botUserId) ||
    (identity.appId !== undefined && !/^[A-Z0-9]+$/.test(identity.appId))
  )
    return undefined;
  return {
    workspaceId: identity.workspaceId,
    ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}),
    ...(identity.appId ? { appId: identity.appId } : {}),
    botUserId: identity.botUserId,
  };
}
