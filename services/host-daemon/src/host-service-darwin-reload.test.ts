import { describe, expect, it } from "vitest";

import { restartHostService } from "./host-service.ts";
import { baseOpts, errRun, okRun, seededFs } from "./host-service-test-helpers.ts";
import {
  missing,
  replacement,
  running,
  steps,
  stopped,
} from "./host-service-darwin-reload-test-helpers.ts";

describe("install-service darwin reload", () => {
  it("accepts a new running pid after bootstrap without kickstart", () => {
    const result = steps({ print: [missing, running] });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(["print", "bootout", "bootstrap", "print"]);
    expect(result.sleepArgs).toEqual([]);
  });

  it("fails safely when a running pre-reload process has no pid", () => {
    const result = steps({ print: okRun("state = running\n") });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual(["print"]);
    expect(result.errors.join("\n")).toMatch(/pre-reload.*without a pid/);
  });

  it("performs one complete reload retry when registration stays missing", () => {
    const result = steps({
      print: [missing, missing, missing, replacement],
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
