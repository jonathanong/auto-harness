import { createServer as createTcpServer } from "node:net";
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { SessionRecord } from "./db/types.ts";
import { startLocalServer } from "./local-server.ts";
import type { SessionArtifactStore } from "./session-artifact-store.ts";

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("session artifact upload authorization", () => {
  it("extends the hold after delayed signing and rejects a claim before returning its URL", async () => {
    let nowMs = Date.now();
    const plane = new ControlPlane({ now: () => new Date(nowMs).toISOString() });
    const initialNow = new Date(nowMs).toISOString();
    for (const id of ["slow-signing", "claimed-during-signing"]) {
      plane.state.sessions.set(id, {
        id,
        repositoryId: "repo",
        status: "completed",
        createdAt: new Date(nowMs - 60_000).toISOString(),
        completedAt: initialNow,
        attemptId: "attempt",
        hostId: "host",
        resolvedRoute: { hostId: "host", attemptId: "attempt" },
        sessionOutputsSupported: true,
      } as SessionRecord);
    }
    const artifactStore: SessionArtifactStore = {
      async upload(sessionId) {
        nowMs += 15_000;
        if (sessionId === "claimed-during-signing") {
          plane.state.sessions.get(sessionId)!.retentionToken = "claimed";
        }
        return {
          method: "PUT",
          url: "https://upload.example/artifact",
          headers: {},
          expiresAt: new Date(nowMs + 60_000).toISOString(),
        };
      },
      async inspect() {
        return null;
      },
      async downloadUrl() {
        return "https://download.example/artifact";
      },
    };
    const port = await freePort();
    const { close } = await startLocalServer({
      port,
      useDynamo: false,
      authMode: "disabled",
      enableWs: false,
      plane,
      sessionArtifactStore: artifactStore,
    });
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({
      attemptId: "attempt",
      capturedAt: initialNow,
      output: { state: "none" },
      artifacts: {
        state: "pending",
        compressedBytes: 1,
        sourceBytes: 1,
        fileCount: 1,
        sha256: "a".repeat(64),
      },
    });
    const prepare = (id: string) =>
      fetch(`${base}/api/v1/sessions/${id}/outputs/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    try {
      const ready = await prepare("slow-signing");
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ artifactUpload: { method: "PUT" } });
      expect(plane.state.sessions.get("slow-signing")?.outputsUploadExpiresAt).toBe(
        new Date(nowMs + 370_000).toISOString(),
      );

      const claimed = await prepare("claimed-during-signing");
      expect(claimed.status).toBe(410);
      expect(await claimed.json()).toMatchObject({ error: { code: "RETENTION_STARTED" } });
      expect(plane.state.sessions.get("claimed-during-signing")?.outputsUploadExpiresAt).toBe(
        new Date(nowMs - 15_000 + 370_000).toISOString(),
      );
    } finally {
      await close();
    }
  });
});
