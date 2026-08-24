import { environmentNamesAreCaseSensitive, type HostRuntimeReport } from "@auto-harness/shared";
import daemonPackage from "../package.json" with { type: "json" };

import type { ProcessRunner } from "./executor.ts";

const DAEMON_VERSION = daemonPackage.version;
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 36;

/** Parse only Git's leading version token; never retain command output for display. */
export function parseGitVersion(output: string): string | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/m.exec(output.trim());
  if (!match) return null;
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText!);
  const minor = Number(minorText!);
  const patch = Number(patchText ?? "0");
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return `${major}.${minor}.${patch}`;
}

export function gitVersionIsSupported(version: string): boolean {
  const [majorText, minorText] = version.split(".");
  if (!majorText || !minorText) return false;
  const major = Number(majorText);
  const minor = Number(minorText);
  return major > MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor >= MIN_GIT_MINOR);
}

export async function probeGitReadiness(
  runner: ProcessRunner,
  platform = process.platform,
): Promise<HostRuntimeReport> {
  let stdout = "";
  try {
    const result = await runner.run({
      argv: ["git", "--version"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      onChunk: (chunk) => {
        if (chunk.stream === "stdout") stdout += chunk.data;
      },
    });
    if (result.exitCode !== 0) {
      return unavailable(platform);
    }
  } catch {
    return unavailable(platform);
  }
  const gitVersion = parseGitVersion(stdout);
  if (!gitVersion) {
    return {
      daemonVersion: DAEMON_VERSION,
      gitVersion: null,
      gitReady: false,
      gitReadinessReason: "git_version_unparseable",
      environmentNamesCaseSensitive: environmentNamesAreCaseSensitive(platform),
    };
  }
  if (!gitVersionIsSupported(gitVersion)) {
    return {
      daemonVersion: DAEMON_VERSION,
      gitVersion,
      gitReady: false,
      gitReadinessReason: "git_version_unsupported",
      environmentNamesCaseSensitive: environmentNamesAreCaseSensitive(platform),
    };
  }
  return {
    daemonVersion: DAEMON_VERSION,
    gitVersion,
    gitReady: true,
    environmentNamesCaseSensitive: environmentNamesAreCaseSensitive(platform),
  };
}

function unavailable(platform: string): HostRuntimeReport {
  return {
    daemonVersion: DAEMON_VERSION,
    gitVersion: null,
    gitReady: false,
    gitReadinessReason: "git_unavailable",
    environmentNamesCaseSensitive: environmentNamesAreCaseSensitive(platform),
  };
}
