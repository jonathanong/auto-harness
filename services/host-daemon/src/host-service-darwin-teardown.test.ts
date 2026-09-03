import { describe, expect, it } from "vitest";

import { installHostService } from "./host-service.ts";
import type { HostServiceRun, HostServiceRunResult } from "./host-service-io.ts";
import { baseOpts, errRun, launchctlByStep, okRun, seededFs } from "./host-service-test-helpers.ts";

const missing = errRun(1, "Could not find service");
const running = okRun("state = running\npid = 100\n");
const replacement = okRun("state = running\npid = 101\n");
const stopped = okRun("state = stopped\n");

function install(run: HostServiceRun) {
  const calls: string[] = [];
  const errors: string[] = [];
  const sleepArgs: string[][] = [];
  const code = installHostService(
    baseOpts({
      platform: "darwin",
      fs: seededFs(),
      error: (msg) => errors.push(msg),
      run: (command, args, opts) => {
        calls.push(command === "launchctl" ? (args[0] ?? command) : command);
        if (command === "/bin/sleep") sleepArgs.push(args);
        return run(command, args, opts);
      },
    }),
  );
  return { calls, code, errors, sleepArgs };
}

function steps(
  replies: Record<string, HostServiceRunResult | HostServiceRunResult[]>,
): ReturnType<typeof install> {
  return install(launchctlByStep(replies));
}

describe("install-service darwin launchd teardown race", () => {
  // Regression test for a real outage: `launchctl bootout` only signals a
  // job, launchd deregisters it several seconds later, and any `bootstrap`
  // issued in between fails with 37/EALREADY (surfaced as a misleading
  // "5: Input/output error"). This models the still-draining daemon: the
  // install must poll until launchd reports it missing, then bootstrap once,
  // rather than racing a fixed sleep into a `load -w` fallback.
  it("waits for a still-draining daemon to be deregistered before bootstrapping", () => {
    const result = steps({
      print: [running, running, running, running, running, missing, replacement],
    });
    expect(result.code).toBe(0);
    expect(result.calls.filter((step) => step === "bootstrap")).toHaveLength(1);
    expect(result.calls).not.toContain("load");
    expect(result.sleepArgs).toEqual([["1"], ["1"], ["1"], ["1"]]);
  });

  it("retries bootstrap when launchd says the job is already loaded", () => {
    for (const first of [
      errRun(5, "Bootstrap failed: 5: Input/output error"),
      errRun(1, "already exists"),
      errRun(1, "already been loaded"),
      errRun(37, "already in progress"),
    ]) {
      const result = steps({
        bootstrap: [first, okRun()],
        print: [missing, missing, running],
      });
      expect(result.code).toBe(0);
      expect(result.calls).toEqual([
        "print",
        "bootout",
        "bootstrap",
        "bootout",
        "print",
        "bootstrap",
        "print",
      ]);
      expect(result.sleepArgs).toEqual([]);
    }
  });

  it("falls back to load after an already-loaded bootstrap retry still fails", () => {
    const result = steps({
      bootstrap: [errRun(5, "Input/output error"), errRun(1, "still busy")],
      print: [missing, missing, running],
    });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      "print",
      "bootout",
      "bootstrap",
      "bootout",
      "print",
      "bootstrap",
      "/bin/sleep",
      "load",
      "print",
    ]);
    expect(result.sleepArgs).toEqual([["1"]]);
  });

  it("does not trust launchctl load -w's exit code and reports the last bootstrap error", () => {
    const result = steps({
      bootstrap: [errRun(5, "Bootstrap failed: 5: Input/output error"), errRun(1, "still busy")],
      load: { status: 0, stdout: "", stderr: "Load failed: 5: Input/output error" },
      print: [missing, missing],
    });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([
      "print",
      "bootout",
      "bootstrap",
      "bootout",
      "print",
      "bootstrap",
      "/bin/sleep",
      "load",
    ]);
    expect(result.sleepArgs).toEqual([["1"]]);
    expect(result.errors.join("\n")).toMatch(
      /bootstrap\/load failed: Load failed: 5: Input\/output error/,
    );
    expect(result.errors.join("\n")).toMatch(/last bootstrap: still busy/);
  });

  it("leaves the load failure message untouched when the last bootstrap gave no detail", () => {
    const result = steps({
      bootstrap: errRun(1, ""),
      load: errRun(1, "launchctl broken"),
      print: missing,
    });
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toMatch(/bootstrap\/load failed: launchctl broken/);
    expect(result.errors.join("\n")).not.toContain("(last bootstrap:");
  });

  it("does not accept a running pid that survived the reload", () => {
    const result = steps({
      print: [
        running,
        missing,
        running,
        running,
        running,
        running,
        running,
        running,
        missing,
        replacement,
      ],
    });
    expect(result.code).toBe(0);
    expect(result.calls.filter((step) => step === "bootstrap")).toHaveLength(2);
    expect(result.calls.filter((step) => step === "/bin/sleep")).toHaveLength(5);
  });

  it("fails after two passes when launchd never exposes a running pid", () => {
    // The service never reports "missing", so pass two's teardown wait spends
    // its whole shared budget (90) before giving bootstrap another try, on
    // top of the two independent 5-retry waitForReplacement waits (one per
    // pass) — modeling a launchd that never finishes deregistering the job.
    const result = steps({
      print: [missing, stopped],
    });
    expect(result.code).toBe(1);
    expect(result.calls.filter((step) => step === "bootstrap")).toHaveLength(2);
    expect(result.calls.filter((step) => step === "/bin/sleep")).toHaveLength(100);
    expect(result.errors.join("\n")).toMatch(/launch agent is stopped/);
  });
});
