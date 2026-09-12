import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const GITHUB_PULL_REF_CONFIG_ENV = "HARNESS_GITHUB_PULL_REF_CONFIG";

type GitHubPullRefTransport = Readonly<{
  credentialHelper?: string;
  httpProxy?: string;
  sslCAInfo?: string;
}>;

export type GitHubPullRefConfig = Readonly<{
  remoteUrl: string;
  transport: GitHubPullRefTransport;
}>;

export type GitHubPullRefConfigs = ReadonlyMap<string, GitHubPullRefConfig>;

type PolicyPathStatus = Readonly<{
  uid: number;
  mode: number;
  isSymbolicLink(): boolean;
}>;

type InspectPolicyPath = (path: string) => PolicyPathStatus;

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, context);
}

function httpsUrl(value: string, context: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${context} must be an https URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`${context} must be an https URL`);
  }
  // Git receives this exact string as a transport operand. Return WHATWG's canonical HTTPS form
  // so backslash spellings cannot be interpreted by Git as scp-like SSH syntax.
  return parsed.toString();
}

function assertRootOwnedPath(path: string, inspect: InspectPolicyPath): void {
  for (let current = path; ; current = dirname(current)) {
    const status = inspect(current);
    if (status.isSymbolicLink()) {
      throw new Error(`${GITHUB_PULL_REF_CONFIG_ENV} must not traverse symlinks`);
    }
    if (status.uid !== 0 || (status.mode & 0o022) !== 0) {
      throw new Error(
        `${GITHUB_PULL_REF_CONFIG_ENV} must be root-owned and not group/world writable`,
      );
    }
    if (current === dirname(current)) return;
  }
}

function parseTransport(value: unknown, context: string): GitHubPullRefTransport {
  if (value === undefined) return {};
  const transport = record(value, context);
  if (
    Object.keys(transport).some(
      (key) => !["credentialHelper", "httpProxy", "sslCAInfo"].includes(key),
    )
  ) {
    throw new Error(`${context} has an unsupported key`);
  }
  const credentialHelper = optionalString(
    transport.credentialHelper,
    `${context}.credentialHelper`,
  );
  // Do not accept Git's shell helper form or an arbitrary executable path. The configured helper
  // is resolved by Git from the daemon's trusted PATH.
  if (credentialHelper !== undefined && !/^[A-Za-z0-9_-]+$/.test(credentialHelper)) {
    throw new Error(`${context}.credentialHelper must name a built-in helper`);
  }
  const httpProxy = optionalString(transport.httpProxy, `${context}.httpProxy`);
  if (httpProxy !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(httpProxy);
    } catch {
      throw new Error(`${context}.httpProxy must be an http(s) URL`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new Error(`${context}.httpProxy must be an http(s) URL`);
    }
  }
  const sslCAInfo = optionalString(transport.sslCAInfo, `${context}.sslCAInfo`);
  if (sslCAInfo !== undefined && !isAbsolute(sslCAInfo)) {
    throw new Error(`${context}.sslCAInfo must be absolute`);
  }
  return {
    ...(credentialHelper === undefined ? {} : { credentialHelper }),
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(sslCAInfo === undefined ? {} : { sslCAInfo }),
  };
}

/** Load immutable pull-ref routing and transport policy from a host-local file. */
export function loadGitHubPullRefConfigs(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
  inspect: InspectPolicyPath = lstatSync,
  platformName: NodeJS.Platform = process.platform,
): GitHubPullRefConfigs {
  const path = env[GITHUB_PULL_REF_CONFIG_ENV]?.trim();
  if (!path) return new Map();
  if (platformName === "win32") {
    throw new Error(
      `${GITHUB_PULL_REF_CONFIG_ENV} is unsupported on Windows until native ACL immutability can be verified`,
    );
  }
  if (!isAbsolute(path)) throw new Error(`${GITHUB_PULL_REF_CONFIG_ENV} must be absolute`);
  assertRootOwnedPath(path, inspect);
  const root = record(JSON.parse(readFile(path, "utf8")) as unknown, "GitHub pull-ref config");
  if (Object.keys(root).some((key) => key !== "repositories")) {
    throw new Error("GitHub pull-ref config has an unsupported key");
  }
  const repositories = record(root.repositories, "GitHub pull-ref config.repositories");
  const configs = new Map<string, GitHubPullRefConfig>();
  for (const [repositoryPath, raw] of Object.entries(repositories)) {
    if (!isAbsolute(repositoryPath)) {
      throw new Error("GitHub pull-ref config repository path must be absolute");
    }
    const config = record(raw, `GitHub pull-ref config.repositories.${repositoryPath}`);
    if (Object.keys(config).some((key) => !["remoteUrl", "transport"].includes(key))) {
      throw new Error(
        `GitHub pull-ref config.repositories.${repositoryPath} has an unsupported key`,
      );
    }
    const remoteUrl = httpsUrl(
      nonEmptyString(
        config.remoteUrl,
        `GitHub pull-ref config.repositories.${repositoryPath}.remoteUrl`,
      ),
      `GitHub pull-ref config.repositories.${repositoryPath}.remoteUrl`,
    );
    const canonicalRepositoryPath = resolve(repositoryPath);
    if (configs.has(canonicalRepositoryPath)) {
      throw new Error("GitHub pull-ref config repository paths must not normalize to the same key");
    }
    configs.set(canonicalRepositoryPath, {
      remoteUrl,
      transport: parseTransport(
        config.transport,
        `GitHub pull-ref config.repositories.${repositoryPath}.transport`,
      ),
    });
  }
  return configs;
}
