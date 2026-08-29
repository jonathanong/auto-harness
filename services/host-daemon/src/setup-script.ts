import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { createChildEnv } from "./child-env.ts";
import type { OutputChunk, ProcessResult, ProcessRunner } from "./executor.ts";

const CAPTURE_ENV_SOURCE =
  'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env), { encoding: "utf8", mode: 0o600 })';

function setupShell(environment: NodeJS.ProcessEnv): string {
  const shell = environment.SHELL;
  if (!shell || !isAbsolute(shell) || !existsSync(shell)) return "/bin/sh";
  return /^(?:ba|da|k|z)?sh$/.test(basename(shell)) ? shell : "/bin/sh";
}

function setupCaptureScript(setupScript: string): string {
  return [
    "auto_harness_capture() {",
    "  setup_status=$1",
    "  trap - 0",
    '  if [ "$setup_status" -eq 0 ]; then',
    '    "$2" -e "$3" "$4"',
    "    setup_status=$?",
    "  fi",
    '  exit "$setup_status"',
    "}",
    "auto_harness_setup() {",
    setupScript,
    "}",
    'trap \'auto_harness_capture "$?" "$1" "$2" "$3"\' 0',
    "auto_harness_setup",
  ].join("\n");
}

function capturedEnvironment(value: unknown): NodeJS.ProcessEnv {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("setup script produced an invalid environment snapshot");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && !key.toUpperCase().startsWith("HARNESS_")) {
      environment[key] = entry;
    }
  }
  return environment;
}

/**
 * Run a trusted setup script under the host's POSIX-compatible `$SHELL` (or
 * `/bin/sh`) and capture its exported environment without writing values to
 * session logs. The temporary snapshot is private and removed before return.
 */
export async function runSetupScript(
  runner: ProcessRunner,
  setupScript: string,
  cwd: string,
  timeoutMs: number,
  onChunk: (chunk: OutputChunk) => void,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = createChildEnv(),
): Promise<ProcessResult> {
  const directory = await mkdtemp(join(tmpdir(), "auto-harness-setup-"));
  const snapshotPath = join(directory, "environment.json");
  try {
    const result = await runner.run({
      argv: [
        setupShell(environment),
        "-c",
        setupCaptureScript(setupScript),
        "auto-harness-setup",
        // Resolved via PATH inside the capture trap, not process.execPath:
        // the trap runs in the same shell as the setup script, after it, so
        // PATH already reflects whatever node the setup script itself
        // installed/verified. process.execPath is frozen to whatever
        // interpreter this long-lived daemon happened to launch under, and
        // package managers (brew, nvm, mise) routinely repoint or remove
        // that exact versioned path without the daemon ever restarting.
        "node",
        CAPTURE_ENV_SOURCE,
        snapshotPath,
      ],
      cwd,
      env: environment,
      timeoutMs,
      ...(signal ? { signal } : {}),
      onChunk,
    });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) return result;
    if (result.environment !== undefined) {
      return { ...result, environment: capturedEnvironment(result.environment) };
    }
    try {
      const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as unknown;
      return { ...result, environment: capturedEnvironment(parsed) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("setup script completed without capturing its environment", {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
