import { spawn } from "node:child_process";

function usage(): never {
  console.error("Usage: run-command-with-timeout.mts <1-120 seconds> -- <command> [args...]");
  process.exit(2);
}

const [timeoutValue, separator, command, ...args] = process.argv.slice(2);
const timeoutSeconds = Number(timeoutValue);
if (
  !Number.isInteger(timeoutSeconds) ||
  timeoutSeconds < 1 ||
  timeoutSeconds > 120 ||
  separator !== "--" ||
  !command
) {
  usage();
}

const child = spawn(command, args, { detached: true, stdio: "inherit" });
const exitCode = await new Promise<number>((resolve) => {
  let settled = false;
  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    resolve(code);
  };
  const deadline = setTimeout(() => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group already exited at the deadline.
      }
    }
    finish(124);
  }, timeoutSeconds * 1_000);
  child.once("error", () => {
    console.error("Could not start the bounded readiness command.");
    finish(1);
  });
  child.once("exit", (code) => finish(code ?? 1));
});

process.exitCode = exitCode;
