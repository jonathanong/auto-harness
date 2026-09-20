const immutableGitSha = /^[0-9a-f]{40}$/u;

export function sentryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HARNESS_SENTRY_ENABLED?.trim() === "1";
}

export function resolveSentryRelease(
  env: NodeJS.ProcessEnv = process.env,
  readHead: () => string,
): string | undefined {
  if (!sentryEnabled(env)) return undefined;
  const release = env.HARNESS_SENTRY_RELEASE?.trim() || readHead().trim();
  if (!immutableGitSha.test(release)) {
    throw new Error("HARNESS_SENTRY_RELEASE must be an immutable 40-character git SHA");
  }
  return release;
}
