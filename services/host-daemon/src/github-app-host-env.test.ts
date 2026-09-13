import { generateKeyPairSync } from "node:crypto";
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { loadGitHubAppConfig, parseGitHubAppConfig } from "./github-app.ts";
import {
  envIdentityErrors,
  persistedEnvError,
  validatePersistedEnvFile,
} from "./host-service-env.ts";
import { preparePersistedEnv } from "./host-service-env-persisted.ts";

const identity =
  "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://control.example.com\nHARNESS_API_KEY=secret\n";
const boundIdentity = {
  HARNESS_HOST_ID: "host-1",
  HARNESS_API_URL: "https://d111.cloudfront.net",
  HARNESS_API_KEY: "secret",
};
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs1" })
  .toString();

const appPathCases = [
  { platform: "linux", path: "/etc/auto-harness/github-app.json" },
  { platform: "darwin", path: "/etc/auto-harness/github-app.json" },
  { platform: "linux", path: "C:\\auto-harness\\github-app.json" },
  { platform: "linux", path: "D:/auto-harness/github-app.json" },
  { platform: "darwin", path: "C:\\auto-harness\\github-app.json" },
  { platform: "win32", path: "C:\\auto-harness\\github-app.json" },
  { platform: "win32", path: "D:/auto-harness/github-app.json" },
  { platform: "win32", path: "/etc/auto-harness/github-app.json" },
  { platform: "linux", path: "github-app.json" },
  { platform: "win32", path: "github-app.json" },
  { platform: "win32", path: "C:github-app.json" },
] as const;

function nativeAbsolute(path: string, platform: string): boolean {
  return (platform === "win32" ? win32 : posix).isAbsolute(path);
}

function appConfigJson(privateKeyPath: string): string {
  return JSON.stringify({
    appId: "1",
    privateKeyPath,
    botLogin: "bot",
    botUserId: 1,
    repositories: {},
  });
}

describe("GitHub App host environment", () => {
  it("rejects a relative App configuration path without replacing an existing service file", () => {
    const original = identity;
    expect(
      preparePersistedEnv({
        existing: original,
        example: "",
        env: { HARNESS_GITHUB_APP_CONFIG: "github-app.json" },
      }),
    ).toEqual({ contents: original, errors: ["HARNESS_GITHUB_APP_CONFIG"] });
    expect(persistedEnvError(["HARNESS_GITHUB_APP_CONFIG"])).toContain("absolute path");
    expect(persistedEnvError(["HARNESS_GITHUB_APP_CONFIG"])).toContain("this host platform");
    expect(
      persistedEnvError(["HARNESS_EXECUTION_PROFILES", "HARNESS_GITHUB_APP_CONFIG"]),
    ).toContain("must be absolute paths");
  });

  it.each(appPathCases)("uses $platform native rules for $path", ({ platform, path }) => {
    const persistable = nativeAbsolute(path, platform);
    const prepared = preparePersistedEnv({
      existing: identity,
      example: "",
      env: { HARNESS_GITHUB_APP_CONFIG: path },
      platform,
    });
    const fileErrors = validatePersistedEnvFile(
      `${identity}HARNESS_GITHUB_APP_CONFIG=${path}\n`,
      platform,
    );
    const identityErrors = envIdentityErrors(
      { ...boundIdentity, HARNESS_GITHUB_APP_CONFIG: path },
      platform,
    );
    if (!persistable) {
      expect(prepared).toEqual({ contents: identity, errors: ["HARNESS_GITHUB_APP_CONFIG"] });
      expect(fileErrors).toEqual(["HARNESS_GITHUB_APP_CONFIG"]);
      expect(identityErrors).toEqual(["HARNESS_GITHUB_APP_CONFIG"]);
      expect(() =>
        loadGitHubAppConfig({ HARNESS_GITHUB_APP_CONFIG: path }, () => "{}", platform),
      ).toThrow("HARNESS_GITHUB_APP_CONFIG must be absolute");
      expect(() =>
        parseGitHubAppConfig(JSON.parse(appConfigJson(path)) as unknown, () => pem, platform),
      ).toThrow("privateKeyPath must be absolute");
      return;
    }
    expect(prepared.errors).toEqual([]);
    expect(prepared.contents).toContain(`HARNESS_GITHUB_APP_CONFIG=${path}`);
    expect(fileErrors).toEqual([]);
    expect(identityErrors).toEqual([]);
    const keyPath = platform === "win32" ? "C:\\keys\\app.pem" : "/keys/app.pem";
    expect(
      loadGitHubAppConfig(
        { HARNESS_GITHUB_APP_CONFIG: path },
        (filePath) => (filePath === path ? appConfigJson(keyPath) : pem),
        platform,
      ),
    ).toMatchObject({ appId: "1", botLogin: "bot", botUserId: 1 });
    expect(
      parseGitHubAppConfig(JSON.parse(appConfigJson(path)) as unknown, () => pem, platform),
    ).toMatchObject({ appId: "1", botLogin: "bot", botUserId: 1 });
  });
});
