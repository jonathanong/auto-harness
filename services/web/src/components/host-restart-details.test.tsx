import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HostRestartDetails } from "./host-restart-details.tsx";

describe("HostRestartDetails", () => {
  it("renders singular, timestamps, versions, and ready state", () => {
    const html = renderToStaticMarkup(
      <HostRestartDetails
        hostId="host-1"
        daemonStartedAt="2026-08-23T00:00:00.000Z"
        restartCount={1}
        lastRestartDetectedAt="2026-08-23T01:00:00.000Z"
        daemonVersion="1.2.3"
        gitVersion="2.46.0"
        gitReady
      />,
    );
    expect(html).toContain("1 restart detected");
    expect(html).toContain("Git checkout recovery ready");
    expect(html).toContain("1.2.3");
  });

  it.each([
    ["git_version_unsupported", "Git 2.36 or newer is required"],
    ["git_unavailable", "ensure it is on PATH"],
    ["git_version_unparseable", "supported Git 2.36"],
    [undefined, "Upgrade the host daemon"],
  ])("renders the %s readiness fallback", (reason, message) => {
    const html = renderToStaticMarkup(
      <HostRestartDetails hostId="host-2" gitReadinessReason={reason} />,
    );
    expect(html).toContain("0 restarts detected");
    expect(html).toContain("legacy/unknown");
    expect(html).toContain(message);
  });
});
