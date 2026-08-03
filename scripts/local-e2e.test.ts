/**
 * Structural + real-path test: the Phase 1 local e2e script must exist and
 * exercise SessionRunner + API create on a temp git repo.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCommand } from "./lib/run-command.mts";

describe("local e2e script", () => {
  it("exists at scripts/local-e2e.mts", () => {
    expect(existsSync(join(process.cwd(), "scripts/local-e2e.mts"))).toBe(true);
  });

  it("completes a real create→run session via pnpm local:e2e", async () => {
    const result = await runCommand("pnpm", ["local:e2e"], { cwd: process.cwd() });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(result.stdout).toContain('"status": "completed"');
    expect(result.stdout).toContain("featureSha");
  });
});
