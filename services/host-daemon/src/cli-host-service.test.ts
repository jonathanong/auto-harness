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

  it("passes --api-url as a non-secret persisted URL update", async () => {
    let received: { apiUrl?: string } | undefined;
    const a = deps({
      installService: (opts) => {
        received = opts;
        return 0;
      },
    });
    expect(
      await runCli(["node", "x", "install-service", "--api-url", "https://new.example.com"], {}, a),
    ).toBe(0);
    expect(received?.apiUrl).toBe("https://new.example.com");
  });

  it("persists host-scoped update settings during service installation", async () => {
    let received: NodeJS.ProcessEnv | undefined;
    const a = deps({
      loadConfig: async () => ({
        ...sampleConfig,
        updateConfig: {
          enabled: true,
          manifestUrl: "https://updates.example.test/manifest.json",
          publicKey: "public key",
          installDir: "/srv/auto-harness",
          pollMs: 0,
          daemonVersion: "1.2.3",
        },
      }),
      installService: ({ env }) => {
        received = env;
        return 0;
      },
    });
    expect(await runCli(["node", "x", "install-service"], {}, a)).toBe(0);
    expect(received).toMatchObject({
      HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.test/manifest.json",
      HARNESS_UPDATE_PUBLIC_KEY: "public key",
      HARNESS_UPDATE_INSTALL_DIR: "/srv/auto-harness",
      HARNESS_UPDATE_POLL_MS: "0",
      HARNESS_DAEMON_VERSION: "1.2.3",
    });
  });

  it("clears every persisted updater setting when Host updates are disabled", async () => {
    let received: NodeJS.ProcessEnv | undefined;
    const a = deps({
      loadConfig: async () => ({ ...sampleConfig, updateConfig: { enabled: false } }),
      installService: ({ env }) => {
        received = env;
        return 0;
      },
    });
    expect(await runCli(["node", "x", "install-service"], {}, a)).toBe(0);
    expect(received).toMatchObject({
      HARNESS_UPDATE_MANIFEST_URL: "",
      HARNESS_UPDATE_PUBLIC_KEY: "",
      HARNESS_UPDATE_INSTALL_DIR: "",
      HARNESS_UPDATE_POLL_MS: "",
      HARNESS_DAEMON_VERSION: "",
    });
  });

  it("keeps the existing service environment when remote update settings cannot load", async () => {
    let received: NodeJS.ProcessEnv | undefined;
    const a = deps({
      loadConfig: async () => {
        throw new Error("control plane unavailable");
      },
      installService: ({ env }) => {
        received = env;
        return 0;
      },
    });
    const env = { HARNESS_UPDATE_INSTALL_DIR: "/srv/known-good" };
    expect(await runCli(["node", "x", "install-service"], env, a)).toBe(0);
    expect(received).toBe(env);
    expect(a.errors).toEqual([
      "Could not load host update settings; keeping local service settings: control plane unavailable",
    ]);
  });

  it("refreshes install settings with the persisted service identity", async () => {
    let loadedEnv: NodeJS.ProcessEnv | undefined;
    let installedEnv: NodeJS.ProcessEnv | undefined;
    const a = deps({
      readFile: () =>
        "HARNESS_HOST_ID=persisted\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=key\n",
      loadConfig: async ({ env }) => {
        loadedEnv = env;
        return sampleConfig;
      },
      installService: ({ env }) => {
        installedEnv = env;
        return 0;
      },
    });
    expect(await runCli(["node", "x", "install-service"], { HARNESS_ENV_FILE: "/e" }, a)).toBe(0);
    expect(loadedEnv).toMatchObject({
      HARNESS_HOST_ID: "persisted",
      HARNESS_API_URL: "https://control.example.com",
      HARNESS_API_KEY: "key",
    });
    expect(installedEnv?.HARNESS_HOST_ID).toBe("persisted");
  });

  it("requires a value after --api-url", async () => {
    const a = deps();
    expect(await runCli(["node", "x", "install-service", "--api-url"], {}, a)).toBe(1);
    expect(a.errors[0]).toMatch(/--api-url/);
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

  it("refuses to start with an invalid child environment allowlist", async () => {
    const a = deps();
    expect(
      await runCli(
        ["node", "x", "start"],
        { HARNESS_CHILD_ENV_ALLOWLIST: "AGENT_BLACKBOARD_TOKEN" },
        a,
      ),
    ).toBe(1);
    expect(a.errors).toEqual([
      "HARNESS_CHILD_ENV_ALLOWLIST undefined name: AGENT_BLACKBOARD_TOKEN",
    ]);
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
