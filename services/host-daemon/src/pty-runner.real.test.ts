import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PtyProcessRunner } from "./pty-runner.ts";

/**
 * Best-effort open-fd count, duplicated rather than imported from
 * fd-count.ts to keep this real-PTY regression test independent of that
 * module's own history. /proc/self/fd on Linux, /dev/fd on macOS/BSD.
 */
function countOpenFds(): number {
  const path = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  return readdirSync(path).length;
}

// PtyProcessRunner is POSIX-only: the ruspty backend ships no Windows build,
// and PtyProcessRunner.run() throws before spawning on win32 (see
// pty-runner.test.ts's fake-backed coverage of that guard).
describe.skipIf(process.platform === "win32")("PtyProcessRunner real CLI", () => {
  it("runs an argv-only command inside the documented 120x40 terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "auto-harness-pty-relative-"));
    try {
      const scriptPath = join(root, "terminal-size.mjs");
      writeFileSync(
        scriptPath,
        "#!/usr/bin/env node\nconsole.log(JSON.stringify({ tty: process.stdout.isTTY, columns: process.stdout.columns, rows: process.stdout.rows, literal: process.argv[2] }));\n",
      );
      chmodSync(scriptPath, 0o755);
      const output: string[] = [];
      const literal = "literal;$(never-evaluated)";
      const result = await new PtyProcessRunner().run({
        argv: ["./terminal-size.mjs", literal],
        cwd: root,
        timeoutMs: 5_000,
        onChunk: (chunk) => output.push(chunk.data),
      });

      expect(result).toEqual({ exitCode: 0, signal: null, timedOut: false });
      expect(output.join("")).toContain(
        JSON.stringify({
          tty: true,
          columns: 120,
          rows: 40,
          literal,
        }),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("cancels a running process without leaving its child alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "auto-harness-pty-cancel-"));
    try {
      const scriptPath = join(root, "wait.mjs");
      writeFileSync(
        scriptPath,
        "#!/usr/bin/env node\nconsole.log(`READY:${process.pid}`); setInterval(() => undefined, 1_000);\n",
      );
      chmodSync(scriptPath, 0o755);
      const controller = new AbortController();
      let output = "";
      let childPid: number | undefined;

      const result = await new PtyProcessRunner().run({
        argv: ["./wait.mjs"],
        cwd: root,
        signal: controller.signal,
        timeoutMs: 5_000,
        terminationGraceMs: 100,
        onChunk: (chunk) => {
          output += chunk.data;
          const match = /READY:(\d+)/.exec(output);
          if (match?.[1] && childPid === undefined) {
            childPid = Number(match[1]);
            controller.abort();
          }
        },
      });

      expect(result).toMatchObject({ cancelled: true });
      expect(childPid).toBeDefined();
      await expect
        .poll(
          () => {
            try {
              process.kill(childPid!, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
              throw error;
            }
          },
          { interval: 50, timeout: 2_000 },
        )
        .toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  // Regression guard for the node-pty 1.1.0 fd leak that motivated moving to
  // @replit/ruspty (see #465/#456): unpatched node-pty leaked ~3 fds per
  // spawn on this path even though the process was killed and reaped. A
  // future dependency change that reintroduces a leak of this shape would
  // regress with nothing else in the suite to catch it.
  it("does not leak fds across repeated spawns on the SIGKILL-escalation path", async () => {
    const before = countOpenFds();
    // 20, not a smaller number: baseline noise (unrelated fds opening/closing
    // during the test) is a few fds regardless of spawn count, so a small
    // `spawns` leaves little margin between "baseline noise" and "the
    // threshold this assertion is supposed to catch a real leak against".
    const spawns = 20;
    for (let i = 0; i < spawns; i++) {
      const result = await new PtyProcessRunner().run({
        // Bare command name, not process.execPath: PtyProcessRunner rejects an
        // absolute argv[0] as an assigned-command hijack guard (resolve-executable.ts).
        argv: ["node", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"],
        cwd: process.cwd(),
        timeoutMs: 300,
        terminationGraceMs: 100,
        onChunk: () => undefined,
      });
      expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    }
    // Give the OS a moment to finish reclaiming fds from the reaped children.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = countOpenFds();
    // A real per-spawn leak here is ~3 fds; allow a couple of fds of
    // incidental noise (unrelated to this test) without allowing anything
    // that scales with `spawns`.
    expect(after - before).toBeLessThan(spawns);
  });
});
