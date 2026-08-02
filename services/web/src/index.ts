import { PACKAGE_SCOPE } from "@auto-harness/shared";

import {
  createHttpApiClient,
  createSessionFromUi,
  validateCreateSessionForm,
} from "./create-session.js";
import { startWebServer } from "./server.js";

/** Web UI service identity. */
export const serviceName = `${PACKAGE_SCOPE}/web` as const;

export function getServiceName(): string {
  return serviceName;
}

export { createHttpApiClient, createSessionFromUi, validateCreateSessionForm, startWebServer };
