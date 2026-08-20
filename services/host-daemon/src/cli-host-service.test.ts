import { describe, expect, it, vi } from "vitest";

import { printUsage, runCli } from "./cli.ts";
import { deps, sampleConfig } from "./cli-test-helpers.ts";

describe("install-service CLI", () => {
  it("dispatches install and uninstall", async () => {
    const installed: string[] = [];
    const a = deps({
      installService: () => {
        installed.push("in");
        return 0;
      },
      uninstallService: () => {
        installed.push("out");
        return 0;
      },
    });
    expect(await runCli(["node", "x", "install-service"], {}, a)).toBe(0);
    expect(await runCli(["node", "x", "uninstall-service"], {}, a)).toBe(0);
    expect(installed).toEqual(["in", "out"]);
  });

  it("loads HARNESS_ENV_FILE without overriding existing values", async () => {
    const loaded: NodeJS.ProcessEnv[] = [];
    const a = deps({
      readFile: (path) => {
        expect(path).toBe("/tmp/host-daemon.env");
        return "HARNESS_HOST_ID=from-file\nHARNESS_API_KEY=from-file\n";
      },
      loadConfig: async ({ env: loadedEnv }) => {
        loaded.push(loadedEnv ?? {});
        return sampleConfig;
      },
    });
    expect(
      await runCli(
        ["node", "x", "status"],
        { HARNESS_ENV_FILE: "/tmp/host-daemon.env", HARNESS_HOST_ID: "keep-me" },
        a,
      ),
    ).toBe(0);
    expect(loaded[0]?.HARNESS_HOST_ID).toBe("keep-me");
    expect(loaded[0]?.HARNESS_API_KEY).toBe("from-file");
  });

  it("errors when HARNESS_ENV_FILE cannot be read", async () => {
    const a = deps({
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(await runCli(["node", "x", "status"], { HARNESS_ENV_FILE: "/missing.env" }, a)).toBe(1);
    expect(a.errors[0]).toMatch(/HARNESS_ENV_FILE/);
  });

  it("stringifies a non-Error HARNESS_ENV_FILE read failure", async () => {
    const a = deps({
      readFile: () => {
        throw "missing";
      },
    });
    expect(await runCli(["node", "x", "status"], { HARNESS_ENV_FILE: "/missing.env" }, a)).toBe(1);
    expect(a.errors[0]).toMatch(/missing/);
  });

  it("printUsage defaults to console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printUsage();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
