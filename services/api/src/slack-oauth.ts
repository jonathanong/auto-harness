import { createHash, randomBytes } from "node:crypto";

import { normalizeSlackNotifications, type SlackNotifications } from "@auto-harness/shared";

import type { AuditActor } from "./audit-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SlackAppCredentials, SlackOAuthStateRecord } from "./slack-oauth-types.ts";

const STATE_TTL_SECONDS = 10 * 60;

export type SlackOAuthStartInput = {
  principalId: string;
  actor?: AuditActor;
  expectedVersion: number | null;
  /** Reconnect fence held by the caller; prevents delete/recreate ABA overwrites. */
  expectedInstallationId?: string | null;
  defaultChannel: string;
  /** Public origin resolved at OAuth start by the deployed REST runtime. */
  publicBaseUrl?: string;
  enabled?: boolean;
  notifications?: Partial<SlackNotifications>;
};

export class SlackOAuthStartConflictError extends Error {
  constructor() {
    super("Slack integration changed concurrently; retry");
    this.name = "SlackOAuthStartConflictError";
  }
}

export async function startSlackOAuth(
  state: ControlPlaneState,
  credentials: SlackAppCredentials,
  input: SlackOAuthStartInput,
): Promise<{ url: string }> {
  const stateToken = randomBytes(32).toString("base64url");
  const now = Math.floor(Date.parse(state.now()) / 1000);
  const current = state.storage
    ? await state.storage.getSlackIntegration()
    : state.slackIntegration;
  if ((current?.installationId ?? null) !== (input.expectedInstallationId ?? null))
    throw new SlackOAuthStartConflictError();
  const record: SlackOAuthStateRecord = {
    stateHash: hashState(stateToken),
    publicBaseUrl: input.publicBaseUrl ?? state.publicBaseUrl,
    principalId: input.principalId,
    ...(input.actor ? { actor: { ...input.actor } } : {}),
    expectedVersion: input.expectedVersion,
    expectedInstallationId: current?.installationId ?? null,
    defaultChannel: input.defaultChannel,
    enabled: input.enabled ?? current?.enabled ?? true,
    notifications: normalizeSlackNotifications({
      ...current?.notifications,
      ...input.notifications,
    }),
    expiresAt: now + STATE_TTL_SECONDS,
  };
  const stored = state.storage
    ? await state.storage.putSlackOAuthState(record)
    : putLocalState(state, record);
  if (!stored) throw new Error("unable to create Slack OAuth state");
  const redirectUri = slackCallbackUrl(record.publicBaseUrl);
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "chat:write,app_mentions:read,im:history");
  url.searchParams.set("state", stateToken);
  return { url: url.toString() };
}

export async function consumeSlackOAuth(
  state: ControlPlaneState,
  token: string,
): Promise<SlackOAuthStateRecord | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const now = Math.floor(Date.parse(state.now()) / 1000);
  if (state.storage) return state.storage.consumeSlackOAuthState(hashState(token), now);
  const hash = hashState(token);
  const record = state.slackOAuthStates.get(hash);
  state.slackOAuthStates.delete(hash);
  return record && record.expiresAt > now ? record : null;
}

export function slackCallbackUrl(publicBaseUrl: string): string {
  return new URL("/api/v1/integrations/slack/oauth/callback", publicBaseUrl).toString();
}

/**
 * OAuth's redirect URI must be the HTTPS deployment origin, never the local
 * ControlPlane fallback. The deployment lifecycle publishes a root CloudFront
 * URL, so paths, credentials, and query/fragment components are rejected too.
 */
export function deployedSlackPublicBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function hashState(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function putLocalState(state: ControlPlaneState, record: SlackOAuthStateRecord): boolean {
  if (state.slackOAuthStates.has(record.stateHash)) return false;
  state.slackOAuthStates.set(record.stateHash, record);
  return true;
}
