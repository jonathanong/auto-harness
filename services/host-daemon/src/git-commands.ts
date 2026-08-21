import type { ProcessRunner } from "./executor.ts";
import { truncateUtf8 } from "./executor.ts";

type GitResult = { exitCode: number; stdout: string; stderr: string };

/** Keep Git diagnostics useful without allowing them to become a durable secret sink. */
export const MAX_GIT_DIAGNOSTIC_BYTES = 1_024;
const MAX_CAPTURED_GIT_STDERR_BYTES = 64 * 1_024;
const DIAGNOSTIC_TRUNCATION_MARKER = " [diagnostic truncated]";

function appendBounded(current: string, next: string, maxBytes: number): string {
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  return current + truncateUtf8(next, remaining);
}

function removeTerminalControls(value: string): string {
  const withoutAnsi = value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
  return [...withoutAnsi]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
    })
    .join("");
}

/**
 * Remove credential-shaped material from Git output before it can be used in an
 * exception, session status, or log. This deliberately handles both URL userinfo
 * and common non-URL forms Git helpers emit (Authorization headers and key/value
 * diagnostics). Unknown output is retained only as a short, single-line excerpt.
 */
export function sanitizeGitDiagnostic(stderr: string): string {
  const withoutCredentials = stderr
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]*@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(
      /(^|[^A-Za-z0-9])(authorization|token|access[_-]?token|private[_-]?token|password|passwd|secret|credential|api[_-]?key)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2$3[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|npm_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+)/g,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  // Drop terminal escape sequences and other control characters before the
  // excerpt is forwarded to a UI or persisted by the control plane.
  const normalized = removeTerminalControls(withoutCredentials).replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(normalized, "utf8") <= MAX_GIT_DIAGNOSTIC_BYTES) {
    return normalized;
  }
  const contentBytes =
    MAX_GIT_DIAGNOSTIC_BYTES - Buffer.byteLength(DIAGNOSTIC_TRUNCATION_MARKER, "utf8");
  return `${truncateUtf8(normalized, contentBytes)}${DIAGNOSTIC_TRUNCATION_MARKER}`;
}

export function gitFailure(category: string, stderr?: string): Error {
  const diagnostic = stderr === undefined ? "" : sanitizeGitDiagnostic(stderr);
  return new Error(diagnostic.length > 0 ? `${category}: ${diagnostic}` : category);
}

export async function runGit(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  let stdout = "";
  let stderr = "";
  const result = await runner.run({
    argv: ["git", ...args],
    cwd,
    timeoutMs: 120_000,
    ...(signal ? { signal } : {}),
    onChunk: (c) => {
      if (c.stream === "stdout") {
        stdout += c.data;
      } else {
        stderr = appendBounded(stderr, c.data, MAX_CAPTURED_GIT_STDERR_BYTES);
      }
    },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout,
    stderr: sanitizeGitDiagnostic(stderr),
  };
}

export async function refetchConfiguredRemotes(
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const listed = await runGit(runner, cwd, ["remote"], signal);
  if (listed.exitCode !== 0) {
    return false;
  }
  const remotes = listed.stdout.split(/\r?\n/).filter((remote) => remote.length > 0);
  if (remotes.length === 0) {
    return false;
  }
  for (const remote of remotes) {
    const fetched = await runGit(runner, cwd, ["fetch", "--tags", "--refetch", remote], signal);
    if (fetched.exitCode !== 0) {
      return false;
    }
  }
  return true;
}
