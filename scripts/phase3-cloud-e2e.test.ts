import { describe, expect, it } from "vitest";

import { runCommand } from "./lib/run-command.mts";

describe("phase3 cloud e2e", () => {
  it("create→assign→ack→run→completed via ControlPlane + DaemonLoop", async () => {
    const r = await runCommand("pnpm", ["exec", "node", "scripts/phase3-cloud-e2e.mts"], {
      cwd: process.cwd(),
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const line = r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .at(-1);
    expect(line).toBeTruthy();
    const json = JSON.parse(line!) as {
      ok: boolean;
      status: string;
      unknownProfileRejected: boolean;
      featureSha: string;
      head: string;
      hookEnv: { sessionId: string; status: string; ref: string };
      hookFailureDoesNotFlipStatus: boolean;
    };
    expect(json.ok).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.unknownProfileRejected).toBe(true);
    expect(json.head).toBe(json.featureSha);
    expect(json.hookEnv.status).toBe("completed");
    expect(json.hookEnv.ref).toBe("feature/p3");
    expect(json.hookFailureDoesNotFlipStatus).toBe(true);
  });
});
