import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateGeneratedHostServiceTemplates } from "../services/host-daemon/src/host-service-templates.ts";
import {
  envExampleUrl,
  launcherUrl,
  serviceUrl,
  validateSystemdArtifacts,
  validateSystemdLauncher,
} from "./check-systemd-service.mts";

describe("production host systemd artifacts", () => {
  const service = readFileSync(serviceUrl, "utf8");
  const envExample = readFileSync(envExampleUrl, "utf8");
  const launcher = readFileSync(launcherUrl, "utf8");

  it("keeps the checked-in service and environment contracts safe", () => {
    expect(validateSystemdArtifacts(service, envExample)).toEqual([]);
    expect(validateSystemdLauncher(launcher)).toEqual([]);
    expect(validateGeneratedHostServiceTemplates(service)).toEqual([]);
    expect(envExample).toContain("mode 0600");
    expect(envExample).toContain("REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY");
  });

  it("rejects lost drain semantics, unsupported readiness, and secret-shaped examples", () => {
    expect(
      validateSystemdArtifacts(
        service.replace("TimeoutStopSec=15min\n", "").replace("Type=simple", "Type=notify") +
          "\nWatchdogSec=30s\nExecReload=sh -c true\n",
        envExample.replace("REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY", "hns_real-looking-key"),
      ),
    ).toEqual(
      expect.arrayContaining([
        "missing service directive: Type=simple",
        "missing service directive: TimeoutStopSec=15min",
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
          'ExecStart=/bin/sh "/opt/auto-harness/run-host-daemon.sh"',
          "ExecStart=pnpm local:daemon start",
        ),
        envExample.replace("HARNESS_HOST_ID=REPLACE_WITH_BOUND_HOST_ID\n", ""),
      ),
    ).toEqual(
      expect.arrayContaining([
        'missing service directive: ExecStart=/bin/sh "/opt/auto-harness/run-host-daemon.sh"',
        "forbidden service behavior: pnpm ",
        "missing environment example: HARNESS_HOST_ID",
      ]),
    );
  });

  it("keeps the manual stable launcher on current and forwards daemon arguments", () => {
    expect(validateSystemdLauncher("#!/bin/sh\n")).toEqual(
      expect.arrayContaining([
        "missing systemd launcher fragment: current=/opt/auto-harness/current",
        'missing systemd launcher fragment: cd "$current"',
        'missing systemd launcher fragment: auto-harness-host-daemon.mjs start "$@"',
      ]),
    );
  });
});
