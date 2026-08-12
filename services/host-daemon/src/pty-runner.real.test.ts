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
        "console.log(JSON.stringify({ tty: process.stdout.isTTY, columns: process.stdout.columns, rows: process.stdout.rows, term: process.env.TERM, literal: process.argv[1] }))",
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
        term: "xterm-256color",
        literal,
      }),
    );
  });
});
