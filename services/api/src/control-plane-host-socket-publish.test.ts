import { describe, expect, it } from "vitest";

import { TestControlPlane as ControlPlane } from "../test-helpers/reporting-control-plane.ts";
import {
  clearHostSocketPendingPublish,
  markHostSocketPendingPublish,
} from "./control-plane-host-socket-publish.ts";

describe("pending host socket publish marks", () => {
  it("adds and removes an in-flight connection id", () => {
    const plane = new ControlPlane();
    markHostSocketPendingPublish(plane.state, "winner");
    expect(plane.state.pendingHostSocketPublish.has("winner")).toBe(true);
    clearHostSocketPendingPublish(plane.state, "winner");
    expect(plane.state.pendingHostSocketPublish.has("winner")).toBe(false);
  });
});
