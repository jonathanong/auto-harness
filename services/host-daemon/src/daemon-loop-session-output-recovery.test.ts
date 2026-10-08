import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

describe("DaemonLoop session output recovery", () => {
  it("reports bounded recovery overflow without preventing daemon startup", async () => {
    const { config, cleanup, root } = await makeRepo();
    const outputRoot = join(root, "outputs");
    const lines: string[] = [];
    await mkdir(join(outputRoot, "attempts"), { recursive: true });
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        writeFile(
          join(outputRoot, "attempts", index.toString(16).padStart(64, "0")),
          "invalid intent",
          "utf8",
        ),
      ),
    );
    const loop = new DaemonLoop({
      config,
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
      sessionOutputsDir: outputRoot,
      onLog: (line) => lines.push(line),
    });
    try {
      await loop.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(lines).toContain("session output attempt directory exceeds 100 entries");
    } finally {
      loop.stop();
      cleanup();
    }
  });
});
