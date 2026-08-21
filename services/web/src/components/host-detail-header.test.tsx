// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { HostDetailHeader } from "./host-detail-header.tsx";

describe("HostDetailHeader", () => {
  it("shows drain by default and hides it when the caller cannot drain", () => {
    const shown = mountForm(<HostDetailHeader hostId="h1" />);
    expect(field(shown.container, "host-detail-drain")).toBeTruthy();
    shown.unmount();
    const hidden = mountForm(<HostDetailHeader hostId="h1" canDrain={false} />);
    expect(hidden.container.querySelector('[data-pw="host-detail-drain"]')).toBeNull();
    hidden.unmount();
  });
});
