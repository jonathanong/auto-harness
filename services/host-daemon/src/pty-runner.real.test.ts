import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PtyProcessRunner } from "./pty-runner.ts";

describe("PtyProcessRunner real CLI", () => {
  it("runs an argv-only command inside the documented 120x40 terminal", async () => {
    const output: string[] = [];
    const literal = "literal;$(never-evaluated)";
    const result = await new PtyProcessRunner().run({
      argv: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({ tty: process.stdout.isTTY, columns: process.stdout.columns, rows: process.stdout.rows, literal: process.argv[1] }))",
        literal,
      ],
      cwd: process.cwd(),
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
  });

  it.runIf(process.platform === "win32")(
    "runs .cmd and .bat shims from a spaced path with literal arguments",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "auto harness pty batch "));
      try {
        const scriptPath = join(root, "print-args.mjs");
        writeFileSync(scriptPath, "console.log(JSON.stringify(process.argv.slice(2)));\n");
        const expected = [
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
        ];

        for (const extension of ["cmd", "bat"]) {
          const batchPath = join(root, `argument shim.${extension}`);
          writeFileSync(batchPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
          const output: string[] = [];
          const result = await new PtyProcessRunner().run({
            argv: [batchPath, ...expected],
            cwd: root,
            timeoutMs: 5_000,
            onChunk: (chunk) => output.push(chunk.data),
          });

          expect(result).toEqual({ exitCode: 0, signal: null, timedOut: false });
          expect(output.join("").replaceAll(/[\r\n]/g, "")).toContain(JSON.stringify(expected));
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "cancels a batch shim without leaving its child process alive",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "auto harness pty cancel "));
      try {
        const scriptPath = join(root, "wait.mjs");
        const batchPath = join(root, "wait shim.cmd");
        writeFileSync(
          scriptPath,
          "console.log(`READY:${process.pid}`); setInterval(() => undefined, 1_000);\n",
        );
        writeFileSync(batchPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
        const controller = new AbortController();
        let output = "";
        let childPid: number | undefined;

        const result = await new PtyProcessRunner().run({
          argv: [batchPath],
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
    },
  );
});
