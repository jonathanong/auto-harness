import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { manageRepos } from "./repos.mts";
import { manageWeb } from "./web.mts";

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

  it("uses the authoritative repository ID throughout the web management flow", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "manage-web-repository-test-"));
    try {
      await manageWeb(scratch);
      expect(JSON.parse(readFileSync(join(scratch, "web.json"), "utf8"))).toMatchObject({
        createRepo: 201,
        repositoryId: "repo-web",
        createSched: 201,
        scheduleRepositoryId: "repo-web",
        trigger: 201,
        cancel: 200,
        cancelRepositoryId: "repo-web",
        drain: 200,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
