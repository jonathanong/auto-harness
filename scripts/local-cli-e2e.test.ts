import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("documented CLI local path", () => {
  it("ships scripts/local-cli-e2e.mts", () => {
    expect(existsSync(join(process.cwd(), "scripts/local-cli-e2e.mts"))).toBe(true);
  });

  it("runs pnpm local:agent [--] run-session with ref main", () => {
    const result = spawnSync("pnpm", ["exec", "node", "scripts/local-cli-e2e.mts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain("mainSha");
  });
});
