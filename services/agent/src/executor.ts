import { spawn } from "node:child_process";

export type OutputChunk = {
  stream: "stdout" | "stderr";
  data: string;
};

export type RunProcessOptions = {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  onChunk: (chunk: OutputChunk) => void;
};

export type ProcessResult = {
  exitCode: number | null;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
};

/**
 * Host process runner. Default uses child_process.spawn with shell: false.
 * Tests inject fakes; only this boundary may be mocked for CLI tools.
 */
export interface ProcessRunner {
  run(options: RunProcessOptions): Promise<ProcessResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  async run(options: RunProcessOptions): Promise<ProcessResult> {
    if (options.argv.length === 0) {
      throw new Error("argv must be non-empty");
    }
    const [command, ...args] = options.argv;
    if (!command) {
      throw new Error("argv must be non-empty");
    }

    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);

      child.stdout?.on("data", (buf: Buffer) => {
        options.onChunk({ stream: "stdout", data: buf.toString("utf8") });
      });
      child.stderr?.on("data", (buf: Buffer) => {
        options.onChunk({ stream: "stderr", data: buf.toString("utf8") });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          timedOut,
          signal,
        });
      });
    });
  }
}

/** Run a trusted setup script via /bin/sh -c without shell:true on Node. */
export async function runSetupScript(
  runner: ProcessRunner,
  setupScript: string,
  cwd: string,
  timeoutMs: number,
  onChunk: (chunk: OutputChunk) => void,
): Promise<ProcessResult> {
  return runner.run({
    argv: ["/bin/sh", "-c", setupScript],
    cwd,
    timeoutMs,
    onChunk,
  });
}
