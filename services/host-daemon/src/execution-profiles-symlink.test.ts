import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyExecutionProfile } from "./execution-profiles.ts";

describe("execution profile home resolution", () => {
  it("resolves a symlinked home to a real path with no symlink component", () => {
    const root = mkdtempSync(join(tmpdir(), "execution-profiles-symlink-"));
    try {
      const realHome = join(root, "real-home");
      const symlinkedHome = join(root, "execution-homes", "codex");
      mkdirSync(realHome);
      mkdirSync(join(root, "execution-homes"));
      symlinkSync(realHome, symlinkedHome);

      const env = applyExecutionProfile(
        { PATH: "/bin" },
        { providerAccountId: "acct-codex", home: symlinkedHome, env: {} },
      );

      const resolved = realpathSync(realHome);
      expect(env.HOME).toBe(resolved);
      expect(env.USERPROFILE).toBe(resolved);
      expect(env.HOME).not.toContain("execution-homes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
