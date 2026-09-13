/* eslint-disable max-lines -- App configuration, token validation, and session credential scoping share one boundary. */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { isNativeAbsolutePath } from "./native-absolute-path.ts";

const GITHUB_APP_CONFIG_ENV = "HARNESS_GITHUB_APP_CONFIG";
export const GITHUB_APP_TOKEN_MARGIN_MS = 5 * 60_000;

type RepositoryMapping = {
  installationId: number;
  repositoryId: number;
};

export type GitHubAppConfig = {
  appId: string;
  privateKey: ReturnType<typeof createPrivateKey>;
  botLogin: string;
  botUserId: number;
  repositories: Map<string, RepositoryMapping>;
};

export type InstallationToken = {
  token: string;
  expiresAtMs: number;
};

const GITHUB_TOKEN_ENV_NAMES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

/** Remove ambient GitHub credentials before a mapped App session can run any repository hook. */
export function withoutAmbientGitHubTokens(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scoped = { ...environment };
  for (const name of Object.keys(scoped)) {
    if (GITHUB_TOKEN_ENV_NAMES.has(name.toUpperCase())) delete scoped[name];
  }
  const allowlist = scoped.HARNESS_CHILD_ENV_ALLOWLIST;
  if (allowlist) {
    const remaining = allowlist
      .split(",")
      .filter((name) => !GITHUB_TOKEN_ENV_NAMES.has(name.trim().toUpperCase()))
      .join(",");
    if (remaining) scoped.HARNESS_CHILD_ENV_ALLOWLIST = remaining;
    else delete scoped.HARNESS_CHILD_ENV_ALLOWLIST;
  }
  return scoped;
}

/** Keep mapped commands and hooks away from credentials stored in the daemon user's gh config. */
export function withIsolatedGitHubConfigDir(
  environment: NodeJS.ProcessEnv,
  configDir: string,
): NodeJS.ProcessEnv {
  const allowlist = (environment.HARNESS_CHILD_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name && name.toUpperCase() !== "GH_CONFIG_DIR");
  return {
    ...environment,
    GH_CONFIG_DIR: configDir,
    HARNESS_CHILD_ENV_ALLOWLIST: [...allowlist, "GH_CONFIG_DIR"].join(","),
  };
}

/** Add the one-repository App identity to an already-scrubbed child environment. */
export function withInstallationToken(
  environment: NodeJS.ProcessEnv,
  githubApp: GitHubAppConfig,
  installationToken: InstallationToken,
): NodeJS.ProcessEnv {
  const allowlist = (environment.HARNESS_CHILD_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of [
    "GH_TOKEN",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    if (!allowlist.some((existing) => existing.toUpperCase() === name)) allowlist.push(name);
  }
  return {
    ...environment,
    GH_TOKEN: installationToken.token,
    GIT_AUTHOR_NAME: githubApp.botLogin,
    GIT_AUTHOR_EMAIL: githubBotEmail(githubApp),
    GIT_COMMITTER_NAME: githubApp.botLogin,
    GIT_COMMITTER_EMAIL: githubBotEmail(githubApp),
    HARNESS_CHILD_ENV_ALLOWLIST: allowlist.join(","),
  };
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${context} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${context} must be a positive safe integer`);
  }
  return value;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function rejectUnknown(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`${context} has unknown key: ${unknown}`);
}

export function parseGitHubAppConfig(
  raw: unknown,
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
  platform: string = process.platform,
): GitHubAppConfig {
  const config = record(raw, "GitHub App config");
  rejectUnknown(
    config,
    ["appId", "privateKeyPath", "botLogin", "botUserId", "repositories"],
    "GitHub App config",
  );
  const appId = string(config.appId, "GitHub App config.appId");
  if (!/^\d+$/.test(appId)) throw new Error("GitHub App config.appId must be numeric");
  const privateKeyPath = string(config.privateKeyPath, "GitHub App config.privateKeyPath");
  if (!isNativeAbsolutePath(privateKeyPath, platform))
    throw new Error("GitHub App config.privateKeyPath must be absolute");
  const botLogin = string(config.botLogin, "GitHub App config.botLogin");
  const botUserId = positiveInteger(config.botUserId, "GitHub App config.botUserId");
  const rawRepositories = record(config.repositories, "GitHub App config.repositories");
  const repositories = new Map<string, RepositoryMapping>();
  for (const [repositoryId, rawMapping] of Object.entries(rawRepositories)) {
    if (!repositoryId) throw new Error("GitHub App config repository id must be non-empty");
    const mapping = record(rawMapping, `GitHub App config.repositories.${repositoryId}`);
    rejectUnknown(
      mapping,
      ["installationId", "repositoryId"],
      `GitHub App config.repositories.${repositoryId}`,
    );
    repositories.set(repositoryId, {
      installationId: positiveInteger(
        mapping.installationId,
        `GitHub App config.repositories.${repositoryId}.installationId`,
      ),
      repositoryId: positiveInteger(
        mapping.repositoryId,
        `GitHub App config.repositories.${repositoryId}.repositoryId`,
      ),
    });
  }
  try {
    return {
      appId,
      privateKey: createPrivateKey(readFile(privateKeyPath, "utf8")),
      botLogin,
      botUserId,
      repositories,
    };
  } catch {
    throw new Error("GitHub App private key could not be loaded");
  }
}

/** Optional host-local config. An unset variable intentionally leaves ambient auth unchanged. */
export function loadGitHubAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
  platform: string = process.platform,
): GitHubAppConfig | undefined {
  const path = env[GITHUB_APP_CONFIG_ENV]?.trim();
  if (!path) return undefined;
  if (!isNativeAbsolutePath(path, platform)) {
    throw new Error(`${GITHUB_APP_CONFIG_ENV} must be absolute`);
  }
  return parseGitHubAppConfig(JSON.parse(readFile(path, "utf8")) as unknown, readFile, platform);
}

function jwt(config: GitHubAppConfig, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({ iat: nowSeconds - 60, exp: nowSeconds + 600, iss: config.appId })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), config.privateKey).toString("base64url")}`;
}

function responseToken(value: unknown, expectedRepositoryId: number): InstallationToken {
  const response = record(value, "GitHub App token response");
  const token = string(response.token, "GitHub App token response.token");
  const expiresAt = Date.parse(string(response.expires_at, "GitHub App token response.expires_at"));
  if (!Number.isFinite(expiresAt)) throw new Error("GitHub App token response expiry is invalid");
  const permissions = record(response.permissions, "GitHub App token response.permissions");
  for (const permission of ["contents", "pull_requests", "issues"] as const) {
    if (permissions[permission] !== "write")
      throw new Error(`GitHub App token response lacks ${permission} write permission`);
  }
  for (const [permission, level] of Object.entries(permissions)) {
    const expected = permission === "metadata" ? "read" : "write";
    if (
      !["contents", "pull_requests", "issues", "metadata"].includes(permission) ||
      level !== expected
    ) {
      throw new Error("GitHub App token response has an unexpected permission");
    }
  }
  const repositories = response.repositories;
  if (repositories !== undefined) {
    if (
      !Array.isArray(repositories) ||
      repositories.length !== 1 ||
      record(repositories[0], "GitHub App token response.repositories[0]").id !==
        expectedRepositoryId
    ) {
      throw new Error("GitHub App token response is not scoped to the assigned repository");
    }
  }
  return { token, expiresAtMs: expiresAt };
}

export async function mintInstallationToken(
  config: GitHubAppConfig,
  catalogRepositoryId: string,
  signal: AbortSignal | undefined,
  fetchFn: typeof fetch = fetch,
  nowMs: () => number = Date.now,
): Promise<InstallationToken | undefined> {
  const mapping = config.repositories.get(catalogRepositoryId);
  if (!mapping) return undefined;
  const response = await fetchFn(
    `https://api.github.com/app/installations/${String(mapping.installationId)}/access_tokens`,
    {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt(config, nowMs())}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        repository_ids: [mapping.repositoryId],
        permissions: { contents: "write", pull_requests: "write", issues: "write" },
      }),
    },
  );
  if (!response.ok)
    throw new Error(`GitHub App token request failed (HTTP ${String(response.status)})`);
  return responseToken(await response.json(), mapping.repositoryId);
}

export function githubBotEmail(config: GitHubAppConfig): string {
  return `${String(config.botUserId)}+${config.botLogin}@users.noreply.github.com`;
}
