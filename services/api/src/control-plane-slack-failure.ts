import type { SlackConfigFailure } from "./control-plane-slack.ts";

export function slackConfigUnavailable(): SlackConfigFailure {
  return { ok: false, error: "Slack secret encryption is not configured", unavailable: true };
}

export function slackConfigConflict(): SlackConfigFailure {
  return { ok: false, error: "Slack integration changed concurrently; retry", conflict: true };
}
