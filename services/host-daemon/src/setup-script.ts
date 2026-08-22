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
    "auto_harness_setup() {",
    setupScript,
    "}",
    "auto_harness_setup",
    "setup_status=$?",
    'if [ "$setup_status" -eq 0 ]; then',
    '  "$1" -e "$2" "$3"',
    "  setup_status=$?",
    "fi",
    'exit "$setup_status"',
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
        process.execPath,
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
    try {
      const parsed = JSON.parse(await readFile(snapshotPath, "utf8")) as unknown;
      return { ...result, environment: capturedEnvironment(parsed) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
