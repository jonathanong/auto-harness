import { createControlPlane, type CreateControlPlaneOptions } from "../src/create-plane.ts";
import { testReporting } from "./reporting-control-plane.ts";
/** Existing persistence fixtures explicitly supply their unrelated online reporting boundary. */
export function createAuthorizedControlPlane(
  options: CreateControlPlaneOptions = {},
): ReturnType<typeof createControlPlane> {
  return createControlPlane({
    ...options,
    blackboardReporting: options.blackboardReporting ?? testReporting(),
  });
}
