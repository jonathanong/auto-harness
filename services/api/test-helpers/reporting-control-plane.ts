import { ControlPlane } from "../src/control-plane.ts";
import { createControlPlaneState, type ControlPlaneState } from "../src/control-plane-state.ts";
import { createBlackboardReporting } from "../src/blackboard-reporting.ts";
import type { ControlPlaneOptions } from "../src/control-plane-types.ts";

/** Routing/lifecycle fixtures inject the online controller boundary explicitly. Real admission tests use the production class and HTTP writer. */
export function testReporting() {
  const reporting = createBlackboardReporting({
    schemaVersion: 1,
    version: 1,
    url: "https://reporting.example.test",
    token: "test-only-writer",
    policies: [{ repositoryId: "repo", repository: "owner/repo", principalIds: ["system"] }],
  });
  return {
    ...reporting,
    requiresDurableStorage: false,
    authorizeAssignment: async () => true,
    authorize: async () => true,
  };
}

function prepare(value: ControlPlaneState["storage"]) {
  if (value) {
    value.recordBlackboardAdmissionBlock ??= async () => true;
    value.claimReportingRepair ??= async () => null;
    value.listDueWebhookDeliveries ??= async () => [];
    value.getWebhookDelivery ??= async () => null;
  }
  return value;
}

/** Preserve each test's storage behavior and supply only the unrelated reporting boundary. */
function reportingStorageFixture(state: ControlPlaneState): void {
  let storage = state.storage;
  storage = prepare(storage);
  Object.defineProperty(state, "storage", {
    get: () => storage,
    set: (value: typeof storage) => {
      storage = prepare(value);
    },
    enumerable: true,
    configurable: true,
  });
}

export function createTestControlPlaneState(options: ControlPlaneOptions = {}): ControlPlaneState {
  const state = createControlPlaneState({
    ...options,
    blackboardReporting: options.blackboardReporting ?? testReporting(),
  });
  reportingStorageFixture(state);
  return state;
}

export class TestControlPlane extends ControlPlane {
  constructor(options: ControlPlaneOptions = {}) {
    super({ ...options, blackboardReporting: options.blackboardReporting ?? testReporting() });
    reportingStorageFixture(this.state);
  }
}
