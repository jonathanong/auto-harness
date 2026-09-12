import type { ControlPlaneState } from "./control-plane-state.ts";
import { slackBotTokenOwnership, type SlackBotTokenOwnership } from "./slack-secrets.ts";

/**
 * Re-reads durable state before OAuth cleanup without exposing its credential.
 * An unavailable read or decrypt is intentionally unknown, never evidence that a token is free.
 */
export async function getSlackBotTokenOwnershipDurable(
  state: ControlPlaneState,
  candidate: string,
): Promise<SlackBotTokenOwnership> {
  try {
    const current = state.storage
      ? await state.storage.getSlackIntegration()
      : state.slackIntegration;
    if (!current) return "unowned";
    return slackBotTokenOwnership(state.secretEncryptor, current, candidate);
  } catch {
    return "unknown";
  }
}
