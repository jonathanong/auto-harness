/* eslint-disable max-lines -- host-only App parsing and token minting share one key fixture. */
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_APP_TOKEN_MARGIN_MS,
  githubBotEmail,
  loadGitHubAppConfig,
  mintInstallationToken,
  parseGitHubAppConfig,
  withoutAmbientGitHubTokens,
} from "./github-app.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.privateKey.export({ format: "pem", type: "pkcs1" }).toString();

function config() {
  return parseGitHubAppConfig(
    {
      appId: "123",
      privateKeyPath: "/keys/app.pem",
      botLogin: "auto-harness[bot]",
      botUserId: 456,
      repositories: { "repo-1": { installationId: 789, repositoryId: 101_112 } },
    },
    () => pem,
  );
}

describe("GitHub App credentials", () => {
  it("parses host-only configuration and mints an exactly scoped installation token", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization")!;
      const [header, payload, signature] = authorization.slice("Bearer ".length).split(".");
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({
        alg: "RS256",
      });
      expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
        iss: "123",
      });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          pair.publicKey,
          Buffer.from(signature!, "base64url"),
        ),
      ).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({
        repository_ids: [101_112],
        permissions: { contents: "write", pull_requests: "write", issues: "write" },
      });
      return new Response(
        JSON.stringify({
          token: "ghs_exact-token",
          expires_at: "2026-09-12T01:00:00.000Z",
          permissions: { contents: "write", pull_requests: "write", issues: "write" },
          repositories: [{ id: 101_112 }],
        }),
        { status: 201 },
      );
    });
    const parsed = config();
    await expect(
      mintInstallationToken(parsed, "repo-1", undefined, fetchFn, () => 0),
    ).resolves.toEqual({
      token: "ghs_exact-token",
      expiresAtMs: Date.parse("2026-09-12T01:00:00.000Z"),
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/app/installations/789/access_tokens",
    );
    expect(githubBotEmail(parsed)).toBe("456+auto-harness[bot]@users.noreply.github.com");
    expect(GITHUB_APP_TOKEN_MARGIN_MS).toBe(300_000);
  });

  it("accepts a successful token response without an optional repositories field", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "ghs_exact-token",
            expires_at: "2026-09-12T01:00:00.000Z",
            permissions: { contents: "write", pull_requests: "write", issues: "write" },
          }),
          { status: 201 },
        ),
    );
    await expect(
      mintInstallationToken(config(), "repo-1", undefined, fetchFn),
    ).resolves.toMatchObject({ token: "ghs_exact-token" });
  });

  it("rejects a token response that is not restricted to the assigned repository", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "ghs_exact-token",
            expires_at: "2026-09-12T01:00:00.000Z",
            permissions: { contents: "write", pull_requests: "write", issues: "write" },
            repositories: [{ id: 999 }],
          }),
          { status: 201 },
        ),
    );
    await expect(mintInstallationToken(config(), "repo-1", undefined, fetchFn)).rejects.toThrow(
      "not scoped",
    );
  });

  it("rejects a token response with an unexpected write permission", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "ghs_exact-token",
            expires_at: "2026-09-12T01:00:00.000Z",
            permissions: {
              contents: "write",
              pull_requests: "write",
              issues: "write",
              actions: "write",
            },
            repositories: [{ id: 101_112 }],
          }),
          { status: 201 },
        ),
    );
    await expect(mintInstallationToken(config(), "repo-1", undefined, fetchFn)).rejects.toThrow(
      "unexpected permission",
    );
  });

  it("rejects non-writing required permissions and failed token requests", async () => {
    for (const permission of ["contents", "pull_requests", "issues"] as const) {
      const permissions = { contents: "write", pull_requests: "write", issues: "write" };
      permissions[permission] = "read";
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token: "ghs_exact-token",
              expires_at: "2026-09-12T01:00:00.000Z",
              permissions,
              repositories: [{ id: 101_112 }],
            }),
            { status: 201 },
          ),
      );
      await expect(mintInstallationToken(config(), "repo-1", undefined, fetchFn)).rejects.toThrow(
        `lacks ${permission} write permission`,
      );
    }
    await expect(
      mintInstallationToken(
        config(),
        "repo-1",
        undefined,
        async () => new Response(null, { status: 403 }),
      ),
    ).rejects.toThrow("token request failed (HTTP 403)");
    await expect(mintInstallationToken(config(), "unmapped", undefined)).resolves.toBeUndefined();
  });

  it("rejects malformed or non-absolute host configuration without echoing key data", () => {
    expect(() => parseGitHubAppConfig(null)).toThrow("GitHub App config must be an object");
    expect(() =>
      parseGitHubAppConfig({
        appId: 1,
        privateKeyPath: "/keys/app.pem",
        botLogin: "bot",
        botUserId: 1,
        repositories: {},
      }),
    ).toThrow("appId must be a non-empty string");
    expect(() =>
      parseGitHubAppConfig(
        { appId: "1", privateKeyPath: "key.pem", botLogin: "bot", botUserId: 1, repositories: {} },
        () => pem,
      ),
    ).toThrow("must be absolute");
    expect(() =>
      loadGitHubAppConfig({ HARNESS_GITHUB_APP_CONFIG: "config.json" }, () => "{}"),
    ).toThrow("HARNESS_GITHUB_APP_CONFIG must be absolute");
    if (process.platform !== "win32") {
      expect(() =>
        loadGitHubAppConfig({ HARNESS_GITHUB_APP_CONFIG: "C:\\keys\\config.json" }, () => "{}"),
      ).toThrow("HARNESS_GITHUB_APP_CONFIG must be absolute");
      expect(() =>
        parseGitHubAppConfig({
          appId: "1",
          privateKeyPath: "C:\\keys\\app.pem",
          botLogin: "bot",
          botUserId: 1,
          repositories: {},
        }),
      ).toThrow("privateKeyPath must be absolute");
    }
    expect(
      loadGitHubAppConfig(
        { HARNESS_GITHUB_APP_CONFIG: "C:\\keys\\config.json" },
        (filePath) =>
          filePath === "C:\\keys\\config.json"
            ? JSON.stringify({
                appId: "1",
                privateKeyPath: "C:\\keys\\app.pem",
                botLogin: "bot",
                botUserId: 1,
                repositories: {},
              })
            : pem,
        "win32",
      ),
    ).toMatchObject({ appId: "1", botLogin: "bot", botUserId: 1 });
    expect(
      parseGitHubAppConfig(
        {
          appId: "1",
          privateKeyPath: "C:\\keys\\app.pem",
          botLogin: "bot",
          botUserId: 1,
          repositories: {},
        },
        () => pem,
        "win32",
      ),
    ).toMatchObject({ appId: "1", botLogin: "bot", botUserId: 1 });
    expect(() =>
      parseGitHubAppConfig(
        {
          appId: "not-numeric",
          privateKeyPath: "/keys/app.pem",
          botLogin: "bot",
          botUserId: 1,
          repositories: {},
        },
        () => pem,
      ),
    ).toThrow("appId must be numeric");
    expect(() =>
      parseGitHubAppConfig(
        {
          appId: "1",
          privateKeyPath: "/keys/app.pem",
          botLogin: "bot",
          botUserId: 0,
          repositories: {},
        },
        () => pem,
      ),
    ).toThrow("botUserId must be a positive safe integer");
    expect(() =>
      parseGitHubAppConfig(
        {
          appId: "1",
          privateKeyPath: "/keys/app.pem",
          botLogin: "bot",
          botUserId: 1,
          repositories: {},
        },
        () => {
          throw new Error("read failed: /keys/app.pem");
        },
      ),
    ).toThrow("GitHub App private key could not be loaded");
  });

  it("rejects unknown config keys and empty repository ids", () => {
    expect(() =>
      parseGitHubAppConfig(
        {
          appId: "1",
          privateKeyPath: "/keys/app.pem",
          botLogin: "bot",
          botUserId: 1,
          repositories: {},
          extra: "unexpected",
        },
        () => pem,
      ),
    ).toThrow("GitHub App config has unknown key: extra");
    expect(() =>
      parseGitHubAppConfig(
        {
          appId: "1",
          privateKeyPath: "/keys/app.pem",
          botLogin: "bot",
          botUserId: 1,
          repositories: { "": { installationId: 2, repositoryId: 3 } },
        },
        () => pem,
      ),
    ).toThrow("repository id must be non-empty");
  });

  it("rejects an invalid installation-token expiry", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: "ghs_exact-token",
            expires_at: "not-a-date",
            permissions: { contents: "write", pull_requests: "write", issues: "write" },
            repositories: [{ id: 101_112 }],
          }),
          { status: 201 },
        ),
    );
    await expect(mintInstallationToken(config(), "repo-1", undefined, fetchFn)).rejects.toThrow(
      "expiry is invalid",
    );
  });

  it("scrubs ambient GitHub token names case-insensitively", () => {
    expect(
      withoutAmbientGitHubTokens({
        Github_Token: "secret",
        gh_enterprise_token: "enterprise-secret",
        SAFE: "kept",
        HARNESS_CHILD_ENV_ALLOWLIST: " Github_Token ,SAFE,gh_enterprise_token",
      }),
    ).toEqual({ SAFE: "kept", HARNESS_CHILD_ENV_ALLOWLIST: "SAFE" });
  });
});
