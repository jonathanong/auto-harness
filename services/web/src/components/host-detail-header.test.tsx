// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { field, mountForm } from "../../test-helpers/form-test-helpers.tsx";
import { HostDetailHeader } from "./host-detail-header.tsx";

describe("HostDetailHeader", () => {
  it("shows drain when not draining and resume when draining", () => {
    const idle = mountForm(<HostDetailHeader hostId="h1" />);
    expect(field(idle.container, "host-detail-drain")).toBeTruthy();
    expect(idle.container.querySelector('[data-pw="host-detail-resume"]')).toBeNull();
    idle.unmount();

    const draining = mountForm(<HostDetailHeader hostId="h1" draining />);
    expect(field(draining.container, "host-detail-resume")).toBeTruthy();
    expect(draining.container.querySelector('[data-pw="host-detail-drain"]')).toBeNull();
    draining.unmount();
  });

  it("hides both when the caller cannot drain, regardless of draining state", () => {
    const hidden = mountForm(<HostDetailHeader hostId="h1" canDrain={false} draining />);
    expect(hidden.container.querySelector('[data-pw="host-detail-drain"]')).toBeNull();
    expect(hidden.container.querySelector('[data-pw="host-detail-resume"]')).toBeNull();
    hidden.unmount();
  });
});
