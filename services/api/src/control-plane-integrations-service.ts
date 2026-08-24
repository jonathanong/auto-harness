import type { ControlPlaneState } from "./control-plane-state.ts";
import * as slack from "./control-plane-slack.ts";

/** Slack and other outbound integration configuration. */
export class ControlPlaneIntegrationsService {
  constructor(readonly state: ControlPlaneState) {}

  getSlackIntegration(): ReturnType<typeof slack.getSlackIntegration> {
    return slack.getSlackIntegration(this.state);
  }

  getSlackIntegrationDurable(): ReturnType<typeof slack.getSlackIntegrationDurable> {
    return slack.getSlackIntegrationDurable(this.state);
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

  deleteSlackIntegrationDurable(): ReturnType<typeof slack.deleteSlackIntegrationDurable> {
    return slack.deleteSlackIntegrationDurable(this.state);
  }
}
