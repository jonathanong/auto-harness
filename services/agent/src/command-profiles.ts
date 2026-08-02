import type { CommandProfileConfig } from "./config.js";

export class UnknownCommandProfileError extends Error {
  readonly profile: string;

  constructor(profile: string) {
    super(`Unknown command profile: ${profile}`);
    this.name = "UnknownCommandProfileError";
    this.profile = profile;
  }
}

/**
 * Resolve a named profile to a concrete argv array (Invariant 8 / D4).
 * Prompt is never interpolated into a shell string.
 */
export function resolveCommandArgv(
  profiles: Record<string, CommandProfileConfig>,
  profileName: string,
  prompt: string,
): string[] {
  const profile = profiles[profileName];
  if (!profile) {
    throw new UnknownCommandProfileError(profileName);
  }
  if (profile.argv.length === 0) {
    throw new UnknownCommandProfileError(profileName);
  }
  if (profile.appendPrompt) {
    return [...profile.argv, prompt];
  }
  return [...profile.argv];
}
