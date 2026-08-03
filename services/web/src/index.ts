import { PACKAGE_SCOPE } from "@auto-harness/shared";

import {
  createHttpApiClient,
  createSessionFromUi,
  validateCreateSessionForm,
} from "./create-session.ts";
import { startWebServer } from "./server.ts";

/** Web UI service identity. */
export const serviceName = `${PACKAGE_SCOPE}/web` as const;

export function getServiceName(): string {
  return serviceName;
}

export { createHttpApiClient, createSessionFromUi, validateCreateSessionForm, startWebServer };
