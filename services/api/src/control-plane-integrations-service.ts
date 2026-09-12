import type { ControlPlaneState } from "./control-plane-state.ts";
import * as slack from "./control-plane-slack.ts";
import { getSlackInboundIntegrationDurable } from "./control-plane-slack-inbound.ts";
import { installSlackOAuthIntegrationDurable } from "./control-plane-slack-oauth.ts";
import { getSlackBotTokenOwnershipDurable } from "./slack-oauth-token-ownership.ts";

/** Slack and other outbound integration configuration. */
export class ControlPlaneIntegrationsService {
  readonly state: ControlPlaneState;

  constructor(state: ControlPlaneState) {
    this.state = state;
  }

  getSlackIntegration(): ReturnType<typeof slack.getSlackIntegration> {
    return slack.getSlackIntegration(this.state);
  }

  getSlackIntegrationDurable(): ReturnType<typeof slack.getSlackIntegrationDurable> {
    return slack.getSlackIntegrationDurable(this.state);
  }

  getSlackBotTokenOwnershipDurable(
    candidate: string,
  ): ReturnType<typeof getSlackBotTokenOwnershipDurable> {
    return getSlackBotTokenOwnershipDurable(this.state, candidate);
  }

  getSlackInboundIntegrationDurable(): ReturnType<typeof getSlackInboundIntegrationDurable> {
    return getSlackInboundIntegrationDurable(this.state);
  }

  createSlackIntegrationDurable(
    input: slack.SlackConfigInput,
  ): ReturnType<typeof slack.createSlackIntegrationDurable> {
    return slack.createSlackIntegrationDurable(this.state, input);
  }

  updateSlackIntegrationDurable(
    input: slack.SlackConfigInput,
  ): ReturnType<typeof slack.updateSlackIntegrationDurable> {
    return slack.updateSlackIntegrationDurable(this.state, input);
  }

  patchSlackIntegrationDurable(
    input: slack.SlackSettingsPatch,
  ): ReturnType<typeof slack.patchSlackIntegrationDurable> {
    return slack.patchSlackIntegrationDurable(this.state, input);
  }

  installSlackOAuthIntegrationDurable(
    input: Parameters<typeof installSlackOAuthIntegrationDurable>[1],
  ): ReturnType<typeof installSlackOAuthIntegrationDurable> {
    return installSlackOAuthIntegrationDurable(this.state, input);
  }

  deleteSlackIntegrationDurable(): ReturnType<typeof slack.deleteSlackIntegrationDurable> {
    return slack.deleteSlackIntegrationDurable(this.state);
  }
}
