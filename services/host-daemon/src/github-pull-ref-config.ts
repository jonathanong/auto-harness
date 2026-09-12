import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
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
): GitHubPullRefConfigs {
  const path = env[GITHUB_PULL_REF_CONFIG_ENV]?.trim();
  if (!path) return new Map();
  if (!isAbsolute(path)) throw new Error(`${GITHUB_PULL_REF_CONFIG_ENV} must be absolute`);
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
    const remoteUrl = nonEmptyString(
      config.remoteUrl,
      `GitHub pull-ref config.repositories.${repositoryPath}.remoteUrl`,
    );
    configs.set(resolve(repositoryPath), {
      remoteUrl,
      transport: parseTransport(
        config.transport,
        `GitHub pull-ref config.repositories.${repositoryPath}.transport`,
      ),
    });
  }
  return configs;
}
