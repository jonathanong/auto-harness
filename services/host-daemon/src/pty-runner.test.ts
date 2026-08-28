/* eslint-disable max-lines, unicorn/consistent-function-scoping -- PTY resolution cases use local scenario helpers, matching git-commands.test.ts's precedent for the sibling call site. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { describe, expect, it } from "vitest";

import { PtyProcessRunner, type PtySpawn } from "./pty-runner.ts";

type ExitEvent = { exitCode: number; signal?: number };

function fakePty() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: ExitEvent) => void) | undefined;
  const killed: Array<string | undefined> = [];
  const terminal = {
    pid: 321,
    kill(signal?: string) {
      killed.push(signal);
    },
    onData(listener: (data: string) => void) {
      onData = listener;
      return { dispose() {} };
    },
    onExit(listener: (event: ExitEvent) => void) {
      onExit = listener;
      return { dispose() {} };
    },
  } as IPty;
  return {
    emitData: (data: string) => onData?.(data),
    emitExit: (event: ExitEvent) => onExit?.(event),
    killed,
    terminal,
  };
}

describe("PtyProcessRunner boundary", () => {
  it("passes argv without a shell and fixes the terminal contract at 120x40", async () => {
    const pty = fakePty();
    let spawned: Parameters<PtySpawn> | undefined;
    const runner = new PtyProcessRunner({
      spawn: (...args) => {
        spawned = args;
        queueMicrotask(() => {
          pty.emitData("ready\r\n");
          pty.emitExit({ exitCode: 0 });
        });
        return pty.terminal;
      },
    });
    const chunks: string[] = [];

    await expect(
      runner.run({
        argv: ["/opt/tool", "literal;not-a-shell", "$(still-literal)"],
        cwd: process.cwd(),
        env: { PATH: "/bin", TERM: "caller-value" },
        timeoutMs: 1_000,
        onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.data}`),
      }),
    ).resolves.toEqual({ exitCode: 0, signal: null, timedOut: false });
    expect(spawned).toEqual([
      "/opt/tool",
      ["literal;not-a-shell", "$(still-literal)"],
      {
        cols: 120,
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: "/bin", TERM: "caller-value" },
        name: "xterm-256color",
        rows: 40,
      },
    ]);
    expect(chunks).toEqual(["stdout:ready\r\n"]);
  });

  it("does not spawn after cancellation and explains invalid inputs", async () => {
    let calls = 0;
    const runner = new PtyProcessRunner({
      spawn: () => {
        calls += 1;
        return fakePty().terminal;
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run({
        argv: ["tool"],
        cwd: process.cwd(),
        signal: controller.signal,
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ cancelled: true, exitCode: null });
    await expect(
      runner.run({ argv: [], cwd: process.cwd(), timeoutMs: 1_000, onChunk: () => undefined }),
    ).rejects.toThrow("argv must be non-empty");
    await expect(
      runner.run({
        argv: ["tool"],
        cwd: "/tmp/auto-harness-pty-missing-cwd",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("working directory does not exist");
    expect(calls).toBe(0);
  });

  it("signals the process group and escalates an ignored timeout", async () => {
    const pty = fakePty();
    const signals: Array<[number, NodeJS.Signals]> = [];
    const runner = new PtyProcessRunner({
      kill(pid, signal) {
        signals.push([pid, signal as NodeJS.Signals]);
        if (signal === "SIGKILL") queueMicrotask(() => pty.emitExit({ exitCode: 0, signal: 9 }));
        return true;
      },
      platform: "linux",
      spawn: () => pty.terminal,
    });

    await expect(
      runner.run({
        argv: ["/opt/tool"],
        cwd: process.cwd(),
        timeoutMs: 5,
        terminationGraceMs: 5,
        onChunk: () => undefined,
      }),
    ).resolves.toEqual({ exitCode: null, signal: "SIGKILL", timedOut: true });
    expect(signals).toEqual([
      [-321, "SIGTERM"],
      [-321, "SIGKILL"],
    ]);
  });

  it("still escalates descendants after the PTY leader exits on cancellation", async () => {
    const pty = fakePty();
    const signals: NodeJS.Signals[] = [];
    const controller = new AbortController();
    const runner = new PtyProcessRunner({
      kill(_pid, signal) {
        signals.push(signal as NodeJS.Signals);
        if (signal === "SIGTERM") queueMicrotask(() => pty.emitExit({ exitCode: 0, signal: 15 }));
        return true;
      },
      platform: "darwin",
      spawn: () => pty.terminal,
    });
    const run = runner.run({
      argv: ["/opt/tool"],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      terminationGraceMs: 5,
      onChunk: () => undefined,
    });
    controller.abort();
    await expect(run).resolves.toMatchObject({ cancelled: true, signal: "SIGTERM" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("falls back to node-pty kill and bounds merged output", async () => {
    const pty = fakePty();
    const controller = new AbortController();
    const runner = new PtyProcessRunner({
      kill() {
        throw new Error("group unavailable");
      },
      platform: "linux",
      spawn: () => pty.terminal,
    });
    const chunks: string[] = [];
    const run = runner.run({
      argv: ["/opt/tool"],
      cwd: process.cwd(),
      signal: controller.signal,
      timeoutMs: 1_000,
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    pty.emitData("x".repeat(40_000));
    controller.abort();
    expect(pty.killed).toEqual(["SIGTERM"]);
    pty.emitExit({ exitCode: 0, signal: 15 });
    await expect(run).resolves.toMatchObject({ cancelled: true });
    expect(chunks).toHaveLength(2);
    expect(Buffer.byteLength(chunks[0]!, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(chunks[1]).toContain("output chunk truncated");
  });

  it("normalizes missing-command errors from the native boundary", async () => {
    const runner = new PtyProcessRunner({
      spawn() {
        const error = new Error("File not found");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      },
    });
    await expect(
      runner.run({
        // Absolute, so resolution passes through unchanged and this test
        // exercises the native this.spawn() ENOENT-normalization path
        // rather than resolveTrustedExecutable's own not-found error.
        argv: ["/opt/missing-tool"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("executable not found in PATH");
  });
});

describe("PtyProcessRunner executable resolution", () => {
  function stubBinary(dir: string, filename: string): void {
    // Mode 0o755: resolution requires POSIX candidates to actually be
    // executable, not merely present.
    writeFileSync(join(dir, filename), "", { mode: 0o755 });
  }

  it("resolves a bare command from env.PATH before spawning", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-pty-resolve-"));
    stubBinary(binDir, "claude");
    let spawned: Parameters<PtySpawn> | undefined;
    const runner = new PtyProcessRunner({
      platform: "linux",
      spawn: (...args) => {
        spawned = args;
        const pty = fakePty();
        queueMicrotask(() => pty.emitExit({ exitCode: 0 }));
        return pty.terminal;
      },
    });

    await runner.run({
      argv: ["claude", "--resume"],
      cwd: process.cwd(),
      env: { PATH: binDir },
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(spawned?.[0]).toBe(join(binDir, "claude"));
  });

  it("resolves from PATH, not from a malicious same-named binary planted in the untrusted checkout cwd", async () => {
    // Regression guard for #365: PtyProcessRunner spawns operator-authored
    // resolvedArgv with options.cwd set to the untrusted session worktree.
    // Windows' child_process.spawn (libuv search_path()) checks cwd before
    // PATH for a bare command name, so a same-named binary committed to the
    // checked-out ref must never be resolved, only a real PATH match.
    const untrustedCheckout = mkdtempSync(join(tmpdir(), "auto-harness-pty-untrusted-"));
    stubBinary(untrustedCheckout, "claude.exe");
    const trustedBinDir = mkdtempSync(join(tmpdir(), "auto-harness-pty-trusted-"));
    stubBinary(trustedBinDir, "claude.exe");

    let spawned: Parameters<PtySpawn> | undefined;
    const runner = new PtyProcessRunner({
      platform: "win32",
      spawn: (...args) => {
        spawned = args;
        const pty = fakePty();
        queueMicrotask(() => pty.emitExit({ exitCode: 0 }));
        return pty.terminal;
      },
    });

    await runner.run({
      argv: ["claude"],
      cwd: untrustedCheckout,
      env: { PATH: trustedBinDir, PATHEXT: ".EXE" },
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(spawned?.[0]).toBe(join(trustedBinDir, "claude.exe"));
    expect(spawned?.[0]).not.toBe(join(untrustedCheckout, "claude.exe"));
  });

  it("wraps a resolved Windows batch shim through a trusted cmd.exe command line", async () => {
    const root = mkdtempSync(join(tmpdir(), "auto-harness-pty-batch-"));
    const binDir = join(root, "trusted bin");
    mkdirSync(binDir);
    stubBinary(binDir, "cmd.exe");
    stubBinary(binDir, "tool.cmd");
    let spawned: Parameters<PtySpawn> | undefined;
    const runner = new PtyProcessRunner({
      platform: "win32",
      spawn: (...spawnArgs) => {
        spawned = spawnArgs;
        const pty = fakePty();
        queueMicrotask(() => pty.emitExit({ exitCode: 0 }));
        return pty.terminal;
      },
    });

    await runner.run({
      argv: [
        "tool",
        "",
        "plain",
        "two words",
        'say "hi"',
        "space slash\\",
        'slash\\"quote',
        "trailing\\",
        "a&b",
        "%PATH%",
        "!bang!",
        "(group)",
        "x|y",
        "in<out",
        "caret^",
      ],
      cwd: process.cwd(),
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE" },
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });

    const batchPath = join(binDir, "tool.cmd");
    const escapedBatchPath = `^^^"${batchPath.replaceAll(" ", "^^^ ")}^^^"`;
    expect(spawned?.[0]).toBe(join(binDir, "cmd.exe"));
    expect(spawned?.[1]).toBe(
      `/d /s /c ${escapedBatchPath} "" plain ^^^"two^^^ words^^^" ` +
        '^^^"say^^^ \\^^^"hi\\^^^"^^^" ^^^"space^^^ slash\\\\^^^" ' +
        '^^^"slash\\\\\\^^^"quote^^^" trailing\\ a^^^&b ^^^%PATH^^^% ' +
        "^^^!bang^^^! ^^^(group^^^) x^^^|y in^^^<out caret^^^^",
    );
  });

  it("detects .bat batch shims case-insensitively", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-pty-bat-"));
    stubBinary(binDir, "cmd.exe");
    stubBinary(binDir, "tool.BAT");
    let spawned: Parameters<PtySpawn> | undefined;
    const runner = new PtyProcessRunner({
      platform: "win32",
      spawn: (...spawnArgs) => {
        spawned = spawnArgs;
        const pty = fakePty();
        queueMicrotask(() => pty.emitExit({ exitCode: 0 }));
        return pty.terminal;
      },
    });

    await runner.run({
      argv: [join(binDir, "tool.BAT"), "run"],
      cwd: process.cwd(),
      env: { PATH: binDir },
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(spawned?.[0]).toBe(join(binDir, "cmd.exe"));
    expect(spawned?.[1]).toContain("/d /s /c");
  });

  it.each(["line one\nline two", "line one\rline two", "line one\r\nline two"])(
    "rejects a Windows batch argument containing CR/LF before spawning",
    async (argument) => {
      const binDir = mkdtempSync(join(tmpdir(), "auto-harness-pty-batch-newline-"));
      stubBinary(binDir, "tool.cmd");
      let spawnCalls = 0;
      const runner = new PtyProcessRunner({
        platform: "win32",
        spawn: () => {
          spawnCalls += 1;
          return fakePty().terminal;
        },
      });

      await expect(
        runner.run({
          argv: [join(binDir, "tool.cmd"), argument],
          cwd: process.cwd(),
          env: { PATH: binDir },
          timeoutMs: 1_000,
          onChunk: () => undefined,
        }),
      ).rejects.toThrow(
        "Cannot launch Windows batch command: CR/LF characters are not supported in arguments",
      );
      expect(spawnCalls).toBe(0);
    },
  );

  it("does not fall back to a bare cmd.exe when the trusted PATH has no interpreter", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-pty-no-cmdexe-"));
    stubBinary(binDir, "tool.cmd");
    let spawnCalls = 0;
    const runner = new PtyProcessRunner({
      platform: "win32",
      spawn: () => {
        spawnCalls += 1;
        return fakePty().terminal;
      },
    });

    await expect(
      runner.run({
        argv: [join(binDir, "tool.cmd")],
        cwd: process.cwd(),
        env: { PATH: binDir },
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow('Cannot resolve trusted executable "cmd.exe": not found on PATH');
    expect(spawnCalls).toBe(0);
  });

  it("keeps non-batch Windows and POSIX commands on the direct argv path", async () => {
    const scenarios: Array<{ command: string; platform: NodeJS.Platform }> = [
      { command: "/opt/tool.exe", platform: "win32" },
      { command: "/opt/tool.com", platform: "win32" },
      { command: "/opt/tool.cmd", platform: "linux" },
      { command: "/opt/tool.bat", platform: "darwin" },
    ];

    for (const scenario of scenarios) {
      let spawned: Parameters<PtySpawn> | undefined;
      const runner = new PtyProcessRunner({
        platform: scenario.platform,
        spawn: (...spawnArgs) => {
          spawned = spawnArgs;
          const pty = fakePty();
          queueMicrotask(() => pty.emitExit({ exitCode: 0 }));
          return pty.terminal;
        },
      });

      await runner.run({
        argv: [scenario.command, "literal&argument"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      });

      expect(spawned?.slice(0, 2)).toEqual([scenario.command, ["literal&argument"]]);
    }
  });

  it("throws before spawning when the command is not found anywhere on PATH", async () => {
    let spawnCalls = 0;
    const runner = new PtyProcessRunner({
      platform: "linux",
      spawn: () => {
        spawnCalls += 1;
        return fakePty().terminal;
      },
    });

    await expect(
      runner.run({
        argv: ["missing-tool"],
        cwd: process.cwd(),
        env: { PATH: mkdtempSync(join(tmpdir(), "auto-harness-pty-empty-path-")) },
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow('Cannot resolve trusted executable "missing-tool": not found on PATH');
    expect(spawnCalls).toBe(0);
  });
});
