import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCommand } from "./lib/run-command.mts";

describe("documented CLI local path", () => {
  it("ships scripts/local-cli-e2e.mts", () => {
    expect(existsSync(join(process.cwd(), "scripts/local-cli-e2e.mts"))).toBe(true);
  });

  it("runs pnpm local:daemon [--] run-session with ref main", async () => {
    const result = await runCommand("pnpm", ["exec", "node", "scripts/local-cli-e2e.mts"], {
      cwd: process.cwd(),
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain("mainSha");
  });
});
