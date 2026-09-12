import type { SlackAppCredentials } from "./slack-oauth-types.ts";
import { isSlackSigningSecret } from "./slack-secrets.ts";

/** Parse only at a configuration boundary; error values never include the secret JSON. */
export function parseSlackAppCredentials(
  value: string | undefined,
): SlackAppCredentials | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const { clientId, clientSecret, signingSecret } = parsed as Record<string, unknown>;
    if (
      typeof clientId !== "string" ||
      !clientId ||
      typeof clientSecret !== "string" ||
      !clientSecret ||
      typeof signingSecret !== "string" ||
      !isSlackSigningSecret(signingSecret)
    )
      return undefined;
    return { clientId, clientSecret, signingSecret };
  } catch {
    return undefined;
  }
}
