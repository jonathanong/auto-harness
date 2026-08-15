import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { envExampleUrl, serviceUrl, validateSystemdArtifacts } from "./check-systemd-service.mts";

describe("production host systemd artifacts", () => {
  const service = readFileSync(serviceUrl, "utf8");
  const envExample = readFileSync(envExampleUrl, "utf8");

  it("keeps the checked-in service and environment contracts safe", () => {
    expect(validateSystemdArtifacts(service, envExample)).toEqual([]);
    expect(envExample).toContain("mode 0600");
    expect(envExample).toContain("REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY");
  });

  it("rejects lost drain semantics, unsupported readiness, and secret-shaped examples", () => {
    expect(
      validateSystemdArtifacts(
        service.replace("TimeoutStopSec=infinity\n", "").replace("Type=simple", "Type=notify") +
          "\nWatchdogSec=30s\nExecReload=sh -c true\n",
        envExample.replace("REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY", "hns_real-looking-key"),
      ),
    ).toEqual(
      expect.arrayContaining([
        "missing service directive: Type=simple",
        "missing service directive: TimeoutStopSec=infinity",
        "forbidden service behavior: Type=notify",
        "forbidden service behavior: WatchdogSec=",
        "forbidden service behavior: ExecReload=",
        "forbidden service behavior: sh -c",
        "environment example contains a service-account-shaped secret",
      ]),
    );
  });

  it("rejects missing declared environment inputs and package entrypoints", () => {
    expect(
      validateSystemdArtifacts(
        service.replace(
          "ExecStart=/usr/bin/env node services/host-daemon/bin/auto-harness-host-daemon.mjs start",
          "ExecStart=pnpm local:daemon start",
        ),
        envExample.replace("HARNESS_HOST_ID=REPLACE_WITH_BOUND_HOST_ID\n", ""),
      ),
    ).toEqual(
      expect.arrayContaining([
        "missing service directive: ExecStart=/usr/bin/env node services/host-daemon/bin/auto-harness-host-daemon.mjs start",
        "forbidden service behavior: pnpm ",
        "missing environment example: HARNESS_HOST_ID",
      ]),
    );
  });
});
