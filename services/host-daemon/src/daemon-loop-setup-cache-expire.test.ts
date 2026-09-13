import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";
import { setupCacheFileName, writeStoredSetupCache } from "./setup-script-cache.ts";

describe("DaemonLoop setup-cache expiry", () => {
  it("sweeps orphans on start and after a worktree is removed", async () => {
    const { config, root, cleanup } = await makeRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-loop-setup-cache-"));
    const live = config.repositories[0]!.worktrees[0]!;
    const oldPath = join(root, "wt-old");
    await writeStoredSetupCache(cacheDir, live.id, live.path, "fp", { A: "1" });
    await writeStoredSetupCache(cacheDir, live.id, oldPath, "fp", { B: "2" });
    await writeStoredSetupCache(cacheDir, "removed", live.path, "fp", { C: "3" });
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport, setupCacheDir: cacheDir });
      await loop.start();
      expect(await readdir(cacheDir)).toEqual([setupCacheFileName(live.id, live.path)]);

      await loop.applyInventory({
        ...config,
        repositories: config.repositories.map((repository) => ({
          ...repository,
          worktrees: [],
        })),
      });
      expect(await readdir(cacheDir)).toEqual([]);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
