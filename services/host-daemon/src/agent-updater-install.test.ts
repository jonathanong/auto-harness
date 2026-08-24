import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFileUpdateInstaller, removeStagedVersion } from "./agent-updater-install.ts";

function memoryFs() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    fs: {
      mkdirSync: () => undefined,
      writeFileSync: (path: string, data: Uint8Array) => {
        files.set(path, data);
      },
      readFileSync: (path: string) => {
        const data = files.get(path);
        if (!data) throw new Error(`missing ${path}`);
        return data;
      },
      renameSync: (from: string, to: string) => {
        const data = files.get(from);
        if (!data) throw new Error(`missing ${from}`);
        files.set(to, data);
        files.delete(from);
      },
      rmSync: (path: string) => {
        for (const key of files.keys()) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
      },
    },
  };
}

describe("file update installer", () => {
  it("stages, activates, and rolls back the previous artifact", async () => {
    const { files, fs } = memoryFs();
    const installer = createFileUpdateInstaller({ rootDir: "/opt/auto-harness", fs });
    await installer.stage({ version: "1.2.0", artifact: new Uint8Array([1]) });
    await installer.activate("1.2.0");
    expect(files.get("/opt/auto-harness/current")).toEqual(new Uint8Array([1]));
    await installer.stage({ version: "1.3.0", artifact: new Uint8Array([2]) });
    await installer.activate("1.3.0");
    expect(files.get("/opt/auto-harness/current")).toEqual(new Uint8Array([2]));
    expect(files.get("/opt/auto-harness/previous/artifact")).toEqual(new Uint8Array([1]));
    await installer.rollback();
    expect(files.get("/opt/auto-harness/current")).toEqual(new Uint8Array([1]));
    removeStagedVersion("/opt/auto-harness", "1.3.0", fs);
    expect([...files.keys()].some((key) => key.includes("1.3.0"))).toBe(false);
    await expect(installer.restart()).rejects.toThrow("supervisor restart adapter is required");
  });

  it("writes artifacts through the real filesystem adapter", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ah-update-"));
    try {
      const installer = createFileUpdateInstaller({ rootDir });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array([9]) });
      await installer.activate("1.0.0");
      expect(readFileSync(join(rootDir, "current"))).toEqual(Buffer.from([9]));
      removeStagedVersion(rootDir, "1.0.0");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
