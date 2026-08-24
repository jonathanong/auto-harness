import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateGeneratedHostServiceTemplates } from "../services/host-daemon/src/host-service-templates.ts";
import {
  activationHelperUrl,
  envExampleUrl,
  launcherUrl,
  serviceUrl,
  validateSystemdActivationHelper,
  validateSystemdArtifacts,
  validateSystemdLauncher,
} from "./check-systemd-service.mts";

describe("production host systemd artifacts", () => {
  const service = readFileSync(serviceUrl, "utf8");
  const envExample = readFileSync(envExampleUrl, "utf8");
  const launcher = readFileSync(launcherUrl, "utf8");
  const activationHelper = readFileSync(activationHelperUrl, "utf8");

  it("keeps the checked-in service and environment contracts safe", () => {
    expect(validateSystemdArtifacts(service, envExample)).toEqual([]);
    expect(validateSystemdLauncher(launcher)).toEqual([]);
    expect(validateSystemdActivationHelper(activationHelper)).toEqual([]);
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
          'ExecStart=/bin/sh "/usr/local/lib/auto-harness/run-host-daemon.sh"',
          "ExecStart=pnpm local:daemon start",
        ),
        envExample.replace("HARNESS_HOST_ID=REPLACE_WITH_BOUND_HOST_ID\n", ""),
      ),
    ).toEqual(
      expect.arrayContaining([
        'missing service directive: ExecStart=/bin/sh "/usr/local/lib/auto-harness/run-host-daemon.sh"',
        "forbidden service behavior: pnpm ",
        "missing environment example: HARNESS_HOST_ID",
      ]),
    );
  });

  it("keeps the manual stable launcher on current and forwards daemon arguments", () => {
    expect(validateSystemdLauncher("#!/bin/sh\n")).toEqual(
      expect.arrayContaining([
        "missing systemd launcher fragment: update_root=${HARNESS_UPDATE_INSTALL_DIR:-/opt/auto-harness}",
        'missing systemd launcher fragment: current="$update_root/current"',
        'missing systemd launcher fragment: cd "$current"',
        'missing systemd launcher fragment: auto-harness-host-daemon.mjs start "$@"',
      ]),
    );
  });

  it("rejects a promotion helper that can run activated daemon code or skip its immutable fence", () => {
    expect(
      validateSystemdActivationHelper(
        activationHelper
          .replace("lockTree(extracted)", "")
          .replaceAll("assertSafeArchive(archive)", "")
          .replace('process.argv[2] === "--mark-boot-attempt"', "false")
          .replaceAll('|| "/opt/auto-harness"', "")
          .replace('from "node:crypto"', 'from "./current/daemon.mjs"'),
      ),
    ).toEqual(
      expect.arrayContaining([
        "missing update promotion helper fragment: lockTree(extracted)",
        "missing update promotion helper fragment: assertSafeArchive(archive)",
        'missing update promotion helper fragment: process.argv[2] === "--mark-boot-attempt"',
        'missing update promotion helper fragment: || "/opt/auto-harness"',
        "promotion helper must not import daemon-writable activated code",
      ]),
    );
  });
});
