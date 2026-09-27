export type BlackboardPolicy = {
  repositoryId?: string;
  workspacePoolId?: string;
  repository: string;
  principalIds: string[];
};

/** This machine-facing deployment policy is never accepted from a session, prompt, or host. */
export type BlackboardConfig = {
  schemaVersion: 1;
  version: number;
  url: string;
  token: string;
  policies: BlackboardPolicy[];
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exact(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Never include invalid input or credential values in errors. */
export function parseBlackboardConfig(raw: string): BlackboardConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid Blackboard reporting configuration");
  }
  if (
    !record(value) ||
    !exact(value, ["schemaVersion", "version", "url", "token", "policies"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.url !== "string" ||
    typeof value.token !== "string" ||
    value.token.length < 1 ||
    value.token.length > 8192 ||
    !Array.isArray(value.policies) ||
    value.policies.length < 1 ||
    value.policies.length > 100
  )
    throw new Error("invalid Blackboard reporting configuration");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("invalid Blackboard reporting URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("invalid Blackboard reporting URL");
  const seen = new Set<string>();
  for (const policy of value.policies) {
    if (
      !record(policy) ||
      !exact(policy, ["repositoryId", "workspacePoolId", "repository", "principalIds"]) ||
      (typeof policy.repositoryId === "string") === (typeof policy.workspacePoolId === "string") ||
      (policy.repositoryId !== undefined &&
        (typeof policy.repositoryId !== "string" ||
          !/^[A-Za-z0-9_-]{1,512}$/.test(policy.repositoryId))) ||
      (policy.workspacePoolId !== undefined &&
        (typeof policy.workspacePoolId !== "string" ||
          !/^[A-Za-z0-9_-]{1,512}$/.test(policy.workspacePoolId))) ||
      typeof policy.repository !== "string" ||
      !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(policy.repository) ||
      !Array.isArray(policy.principalIds) ||
      policy.principalIds.length < 1 ||
      policy.principalIds.length > 100 ||
      policy.principalIds.some(
        (principal) => typeof principal !== "string" || !/^[A-Za-z0-9_:.-]{1,512}$/.test(principal),
      )
    )
      throw new Error("invalid Blackboard reporting policy");
    for (const principal of policy.principalIds as string[]) {
      const key = `${policy.workspacePoolId ? "workspace" : "repository"}:${policy.workspacePoolId ?? policy.repositoryId}:${principal}`;
      if (seen.has(key)) throw new Error("duplicate Blackboard reporting policy");
      seen.add(key);
    }
  }
  if (Buffer.byteLength(raw) > 64 * 1024)
    throw new Error("Blackboard reporting configuration too large");
  return value as BlackboardConfig;
}

export function blackboardPolicy(
  config: BlackboardConfig | undefined,
  repositoryId: string,
  principalId: string | undefined,
  workspacePoolId?: string,
): BlackboardPolicy | undefined {
  return config?.policies.find(
    (policy) =>
      (workspacePoolId
        ? policy.workspacePoolId === workspacePoolId
        : policy.repositoryId === repositoryId) &&
      policy.principalIds.includes(principalId ?? "system"),
  );
}
