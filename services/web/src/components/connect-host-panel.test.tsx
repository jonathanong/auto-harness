// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { ConnectHostPanel } from "./connect-host-panel.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
});

describe("ConnectHostPanel", () => {
  it("shows the real connect command, never a raw API Gateway endpoint", () => {
    process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL = "https://d111.cloudfront.net";
    const view = mountForm(<ConnectHostPanel hostId="mac-1" />);
    // Configured (local/e2e build): resolves synchronously, no loading state.
    expect(view.container.textContent).not.toContain("Loading connect instructions");
    const command = field(view.container, "connect-host-command").textContent;
    expect(command).toContain("HARNESS_HOST_ID=mac-1");
    expect(command).toContain("HARNESS_API_URL=https://d111.cloudfront.net");
    expect(command).toContain("pnpm local:daemon start");
    expect(command).not.toContain("local:agent");
    expect(command).not.toContain("execute-api");
    view.unmount();
  });

  it("defers to the browser origin when no build-time override is configured", () => {
    // Simulates a cloud build, where NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL isn't baked in
    // (next.config.ts) — see the hydration-mismatch note on the component for why this must
    // never fall back to controlPlaneUrl()'s server-side 127.0.0.1 default once mounted in a
    // real browser.
    const view = mountForm(<ConnectHostPanel hostId="mac-1" />);
    expect(view.container.textContent).not.toContain("Loading connect instructions");
    const command = field(view.container, "connect-host-command").textContent;
    expect(command).toContain(`HARNESS_API_URL=${window.location.origin}`);
    expect(command).not.toContain("127.0.0.1:7420");
    view.unmount();
  });

  it("copies the exact command and announces success", async () => {
    process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL = "https://d111.cloudfront.net";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    const view = mountForm(<ConnectHostPanel hostId="mac-1" />);
    const command = field(view.container, "connect-host-command").textContent;

    await act(async () => {
      field<HTMLButtonElement>(view.container, "connect-host-copy").click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(command);
    expect(field(view.container, "connect-host-copy").textContent).toBe("Copied");
    expect(field(view.container, "connect-host-copy-status").textContent).toBe("Command copied");
    view.unmount();
  });

  it("announces when clipboard access fails", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const view = mountForm(<ConnectHostPanel hostId="mac-1" />);

    await act(async () => {
      field<HTMLButtonElement>(view.container, "connect-host-copy").click();
      await Promise.resolve();
    });

    expect(field(view.container, "connect-host-copy").textContent).toBe("Copy failed");
    expect(field(view.container, "connect-host-copy-status").textContent).toBe(
      "Could not copy command",
    );
    view.unmount();
  });
});
