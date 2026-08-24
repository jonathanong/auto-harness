import { describe, expect, it } from "vitest";

import { installHostService } from "./host-service.ts";
import type { HostServiceRun, HostServiceRunResult } from "./host-service-io.ts";
import { baseOpts, errRun, launchctlByStep, okRun, seededFs } from "./host-service-test-helpers.ts";

const missing = errRun(1, "Could not find service");
const running = okRun("state = running\n");
const stopped = okRun("state = stopped\n");

function install(run: HostServiceRun): { calls: string[]; code: number; errors: string[] } {
  const calls: string[] = [];
  const errors: string[] = [];
  const code = installHostService(
    baseOpts({
      platform: "darwin",
      fs: seededFs(),
      error: (msg) => errors.push(msg),
      run: (command, args, opts) => {
        calls.push(args[0] ?? command);
        return run(command, args, opts);
      },
    }),
  );
  return { calls, code, errors };
}

function steps(
  replies: Record<string, HostServiceRunResult | HostServiceRunResult[]>,
): ReturnType<typeof install> {
  return install(launchctlByStep(replies));
}

describe("install-service darwin reload", () => {
  it("skips kickstart when bootstrap already left the agent running", () => {
    const result = install((_command, args) => (args[0] === "print" ? running : okRun()));
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["bootout", "bootstrap", "print"]);
  });

  it("retries bootstrap when launchd says the job is already loaded", () => {
    for (const first of [
      errRun(5, "Bootstrap failed: 5: Input/output error"),
      errRun(1, "already exists"),
      errRun(1, "already been loaded"),
      errRun(37, "already in progress"),
    ]) {
      const result = steps({ bootstrap: [first, okRun()], print: running });
      expect(result.code).toBe(0);
      expect(result.calls).toEqual(["bootout", "bootstrap", "bootout", "bootstrap", "print"]);
    }
  });

  it("falls back to load after an already-loaded bootstrap retry still fails", () => {
    const result = steps({ bootstrap: errRun(5, "Input/output error"), print: running });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["bootout", "bootstrap", "bootout", "bootstrap", "load", "print"]);
  });

  it("reloads a missing print then skips kickstart once running", () => {
    const result = steps({ print: [missing, running] });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      "bootout",
      "bootstrap",
      "print",
      "bootout",
      "bootstrap",
      "print",
    ]);
  });

  it("treats kickstart already-in-progress as success when registered", () => {
    expect(steps({ print: [stopped, running], kickstart: errRun(37, "") }).code).toBe(0);
    expect(
      steps({
        print: [okRun("state = waiting\n"), running],
        kickstart: errRun(1, "already in progress"),
      }).code,
    ).toBe(0);
    expect(steps({ print: stopped, kickstart: errRun(37, "") }).code).toBe(0);
    expect(steps({ print: [stopped, missing, stopped], kickstart: errRun(37, "") }).code).toBe(0);
    expect(steps({ print: [stopped, missing, stopped] }).code).toBe(0);
  });

  it("reports kickstart failure when the agent stays stopped", () => {
    const result = steps({ print: stopped, kickstart: errRun(1, "kick") });
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toMatch(/kickstart/);
  });

  it("re-bootstraps after a kickstart race unregisters the agent", () => {
    const result = steps({
      print: [stopped, missing, missing, running],
      kickstart: errRun(37, ""),
    });
    expect(result.code).toBe(0);
    expect(result.calls.filter((step) => step === "bootstrap")).toEqual(["bootstrap", "bootstrap"]);
  });

  it("recovers kickstart failures by reloading a missing agent", () => {
    expect(steps({ print: [stopped, missing, running], kickstart: errRun(1, "kick") }).code).toBe(
      0,
    );
    expect(steps({ print: [stopped, missing, missing, running] }).code).toBe(0);
  });

  it("reports unrecoverable kickstart, verification, and reload failures", () => {
    expect(
      install(launchctlByStep({ print: missing, kickstart: errRun(1, "kick") })).errors.join("\n"),
    ).toMatch(/kickstart/);
    expect(
      install(launchctlByStep({ print: missing, kickstart: errRun(37, "") })).errors.join("\n"),
    ).toMatch(/verification/);
    expect(
      install(
        launchctlByStep({
          bootstrap: [okRun(), errRun(1, "no bootstrap")],
          load: errRun(1, "no load"),
          print: [stopped, missing],
          kickstart: errRun(1, "kick"),
        }),
      ).errors.join("\n"),
    ).toMatch(/bootstrap\/load/);
    expect(
      install(
        launchctlByStep({
          bootstrap: [okRun(), errRun(1, "no bootstrap")],
          load: errRun(1, "no load"),
          print: missing,
        }),
      ).errors.join("\n"),
    ).toMatch(/bootstrap\/load/);
  });
});
