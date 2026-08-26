import { describe, expect, it } from "vitest";

import { installHostService, restartHostService } from "./host-service.ts";
import type { HostServiceRun, HostServiceRunResult } from "./host-service-io.ts";
import { baseOpts, errRun, launchctlByStep, okRun, seededFs } from "./host-service-test-helpers.ts";

const missing = errRun(1, "Could not find service");
const running = okRun("state = running\npid = 100\n");
const replacement = okRun("state = running\npid = 101\n");
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
        calls.push(command === "launchctl" ? (args[0] ?? command) : command);
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
  it("accepts a new running pid after bootstrap without kickstart", () => {
    const result = steps({ print: [missing, running] });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["print", "bootout", "bootstrap", "print"]);
  });

  it("fails safely when a running pre-reload process has no pid", () => {
    const result = steps({ print: okRun("state = running\n") });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual(["print"]);
    expect(result.errors.join("\n")).toMatch(/pre-reload.*without a pid/);
  });

  it("retries bootstrap when launchd says the job is already loaded", () => {
    for (const first of [
      errRun(5, "Bootstrap failed: 5: Input/output error"),
      errRun(1, "already exists"),
      errRun(1, "already been loaded"),
      errRun(37, "already in progress"),
    ]) {
      const result = steps({ bootstrap: [first, okRun()], print: [missing, running] });
      expect(result.code).toBe(0);
      expect(result.calls).toEqual([
        "print",
        "bootout",
        "bootstrap",
        "bootout",
        "bootstrap",
        "print",
      ]);
    }
  });

  it("falls back to load after an already-loaded bootstrap retry still fails", () => {
    const result = steps({
      bootstrap: errRun(5, "Input/output error"),
      print: [missing, running],
    });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      "print",
      "bootout",
      "bootstrap",
      "bootout",
      "bootstrap",
      "load",
      "print",
    ]);
  });

  it("does not trust launchctl load -w's exit code when it reports a load failure", () => {
    const result = steps({
      bootstrap: errRun(5, "Bootstrap failed: 5: Input/output error"),
      load: { status: 0, stdout: "", stderr: "Load failed: 5: Input/output error" },
    });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual(["print", "bootout", "bootstrap", "bootout", "bootstrap", "load"]);
    expect(result.errors.join("\n")).toMatch(
      /bootstrap\/load failed: Load failed: 5: Input\/output error/,
    );
  });

  it("performs one complete reload retry when registration stays missing", () => {
    const result = steps({
      print: [missing, missing, replacement],
    });
    expect(result.code).toBe(0);
    expect(result.calls.filter((step) => step === "bootstrap")).toHaveLength(2);
    expect(result.calls).not.toContain("/bin/sleep");
  });

  it("kickstarts without -k and waits for a new running pid", () => {
    const result = steps({ print: [missing, stopped, stopped, replacement] });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      "print",
      "bootout",
      "bootstrap",
      "print",
      "kickstart",
      "print",
      "/bin/sleep",
      "print",
    ]);
  });

  it("accepts exit 37 only after launchd exposes the replacement pid", () => {
    const result = steps({
      print: [missing, okRun("state = waiting\n"), stopped, replacement],
      kickstart: errRun(37, "already in progress"),
    });
    expect(result.code).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("kickstarts an unstructured transitional state", () => {
    const result = steps({
      print: [missing, okRun("state = transitional\n"), replacement],
    });
    expect(result.code).toBe(0);
    expect(result.calls).toContain("kickstart");
  });

  it("does not accept a running pid that survived the reload", () => {
    const result = steps({
      print: [running, running, running, running, running, running, running, replacement],
    });
    expect(result.code).toBe(0);
    expect(result.calls.filter((step) => step === "bootstrap")).toHaveLength(2);
    expect(result.calls.filter((step) => step === "/bin/sleep")).toHaveLength(5);
  });

  it("fails after two passes when launchd never exposes a running pid", () => {
    const result = steps({
      print: [missing, stopped],
    });
    expect(result.code).toBe(1);
    expect(result.calls.filter((step) => step === "bootstrap")).toHaveLength(2);
    expect(result.calls.filter((step) => step === "/bin/sleep")).toHaveLength(10);
    expect(result.errors.join("\n")).toMatch(/launch agent is stopped/);
  });

  it("rejects a successful kickstart when launchd retains the prior daemon pid", () => {
    const errors: string[] = [];
    let printCalls = 0;
    const code = restartHostService(
      baseOpts({
        platform: "darwin",
        fs: seededFs(),
        error: (message) => errors.push(message),
        run: (_command, args) => {
          if (args[0] === "print") {
            printCalls += 1;
            return okRun("state = running\npid = 100\n");
          }
          return okRun();
        },
      }),
    );
    expect(printCalls).toBe(2);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("launchd kept the prior daemon pid");
  });

  it("reports the final kickstart failure when neither pass becomes running", () => {
    const result = steps({ print: [missing, stopped], kickstart: errRun(1, "kick failed") });
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toMatch(/kickstart.*kick failed/);
  });

  it("requires a numeric pid even when launchctl reports running", () => {
    const result = steps({ print: [missing, okRun("state = running\n")] });
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toMatch(/without a pid/);
  });

  it("reports an unchanged pid after both activation passes", () => {
    const result = steps({ print: running });
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toMatch(/kept the prior daemon pid/);
  });
});
