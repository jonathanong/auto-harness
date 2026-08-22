import type { ProcessRunner } from "./executor.ts";
import { truncateUtf8 } from "./executor.ts";

type GitResult = { exitCode: number; stdout: string; stderr: string };

/** Keep Git diagnostics useful without allowing them to become a durable secret sink. */
export const MAX_GIT_DIAGNOSTIC_BYTES = 1_024;
const MAX_CAPTURED_GIT_STDERR_BYTES = 64 * 1_024;
const DIAGNOSTIC_TRUNCATION_MARKER = " [diagnostic truncated]";
const OUTPUT_CHUNK_TRUNCATION_MARKER = "[output chunk truncated]";

function appendBounded(current: string, next: string, maxBytes: number): string {
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  return current + truncateUtf8(next, remaining);
}

function discardTrailingLine(value: string): string {
  const lastLineBreak = Math.max(value.lastIndexOf("\n"), value.lastIndexOf("\r"));
  return lastLineBreak < 0 ? "" : value.slice(0, lastLineBreak + 1);
}

function completeCapturedLines(value: string, truncated: boolean): string {
  return truncated ? discardTrailingLine(value) : value;
}

const CREDENTIAL_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "private_token",
  "password",
  "passwd",
  "secret",
  "credential",
  "api_key",
]);

function redactQueryCredentials(value: string): string {
  return value.replace(/([?&])([^=\s&#]+)=([^&#\s]*)/g, (match, separator, encodedKey) => {
    let key: string;
    try {
      key = decodeURIComponent(encodedKey).toLowerCase().replaceAll("-", "_");
    } catch {
      return match;
    }
    return CREDENTIAL_QUERY_KEYS.has(key) ? `${separator}${encodedKey}=[redacted]` : match;
  });
}

function skipCsi(value: string, index: number): number {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function skipControlString(value: string, index: number, allowBell: boolean): number {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if ((allowBell && code === 0x07) || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

function skipEscapeSequence(value: string, index: number): number {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x30 && code <= 0x7e) break;
    if (code < 0x20 || code > 0x2f) break;
  }
  return index;
}

function removeTerminalControls(value: string): string {
  const output: string[] = [];
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) index = skipCsi(value, index + 2);
      else if (next === 0x5d) index = skipControlString(value, index + 2, true);
      else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipControlString(value, index + 2, false);
      } else index = skipEscapeSequence(value, index + 1);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(value, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipControlString(value, index + 1, code === 0x9d);
      continue;
    }
    index += 1;
    if (
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && (code < 0x80 || code > 0x9f))
    ) {
      output.push(String.fromCharCode(code));
    }
  }
  return output.join("");
}

/**
 * Remove credential-shaped material from Git output before it can be used in an
 * exception, session status, or log. This deliberately handles both URL userinfo
 * and common non-URL forms Git helpers emit (Authorization headers and key/value
 * diagnostics). Unknown output is retained only as a short, single-line excerpt.
 */
export function sanitizeGitDiagnostic(stderr: string): string {
  const withoutTerminalControls = removeTerminalControls(stderr).replaceAll("\\/", "/");
  const withoutCredentials = redactQueryCredentials(withoutTerminalControls)
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]*@/gi, "$1[redacted]@")
    .replace(
      /(^|[^A-Za-z0-9])(["']?)(authorization|token|access[_-]?token|private[_-]?token|password|passwd|secret|credential|api[_-]?key)\2(\s*[:=]\s*)[^\r\n]+/gi,
      "$1$2$3$2$4[redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
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
  let stderrCaptureTruncated = false;
  let discardStderrContinuation = false;
  const result = await runner.run({
    argv: ["git", ...args],
    cwd,
    timeoutMs: 120_000,
    ...(signal ? { signal } : {}),
    onChunk: (c) => {
      if (c.stream === "stdout") {
        stdout += c.data;
      } else {
        if (c.data.includes(OUTPUT_CHUNK_TRUNCATION_MARKER)) {
          stderr = discardTrailingLine(stderr);
          discardStderrContinuation = true;
          stderr = appendBounded(stderr, c.data, MAX_CAPTURED_GIT_STDERR_BYTES);
          return;
        }
        let data = c.data;
        if (discardStderrContinuation) {
          const lineBreak = data.search(/[\r\n]/);
          if (lineBreak < 0) return;
          discardStderrContinuation = false;
          data = data.slice(lineBreak + 1);
        }
        const remaining = MAX_CAPTURED_GIT_STDERR_BYTES - Buffer.byteLength(stderr, "utf8");
        if (Buffer.byteLength(data, "utf8") > remaining) stderrCaptureTruncated = true;
        stderr = appendBounded(stderr, data, MAX_CAPTURED_GIT_STDERR_BYTES);
      }
    },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout,
    stderr: sanitizeGitDiagnostic(completeCapturedLines(stderr, stderrCaptureTruncated)),
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
