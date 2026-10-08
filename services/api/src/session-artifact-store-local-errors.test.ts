import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { LocalSessionArtifactStore } from "./session-artifact-store.ts";

describe("local artifact filesystem failures", () => {
  it("rejects same-length corrupt bytes and propagates non-missing filesystem failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-artifact-errors-"));
    const store = new LocalSessionArtifactStore(dir);
    const correct = Buffer.from("payload");
    const sha256 = createHash("sha256").update(correct).digest("hex");
    await expect(
      store.put(Readable.from([Buffer.from("payl0ad")]) as never, "sess", "attempt", {
        size: correct.length,
        sha256,
      }),
    ).rejects.toThrow("artifact integrity mismatch");
    expect(await store.inspect("sess", "attempt")).toBeNull();

    const parentFile = join(dir, "regular-file");
    await writeFile(parentFile, "not a directory");
    const obstructed = new LocalSessionArtifactStore(parentFile);
    await expect(obstructed.inspect("sess", "attempt")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(obstructed.deleteSession("sess", "attempt")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});
