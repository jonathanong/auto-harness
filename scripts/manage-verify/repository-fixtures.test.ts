import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { manageRepos } from "./repos.mts";

describe("management smoke repository fixtures", () => {
  it("follows the current repository route contract end to end", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "manage-repository-test-"));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await manageRepos(scratch);
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(readFileSync(join(scratch, "manage-repos.log"), "utf8"))).toMatchObject({
        ok: true,
        steps: [
          { create: 201, body: { id: "repo-manage", name: "demo" } },
          { get: 200 },
          { list: 200 },
          { put: 200, body: { name: "demo2" } },
          { del: 204 },
          { getAfterDelete: 404 },
        ],
      });
    } finally {
      process.exitCode = previousExitCode;
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
