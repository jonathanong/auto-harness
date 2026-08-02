import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("phase3 websocket e2e", () => {
  it("create→assign→run over real local /ws", () => {
    const r = spawnSync("pnpm", ["exec", "tsx", "scripts/phase3-ws-e2e.mts"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const line = r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .at(-1);
    const json = JSON.parse(line!) as {
      ok: boolean;
      status: string;
      transport: string;
      head: string;
      featureSha: string;
    };
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.transport).toBe("websocket");
    expect(json.head).toBe(json.featureSha);
  });
});
