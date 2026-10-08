import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { SessionRecord } from "./db/types.ts";
import { handleSessionOutputRoutes } from "./local-routes-session-outputs.ts";
import { LocalSessionArtifactStore } from "./session-artifact-store.ts";
import { MemorySessionOutputsStore } from "./session-outputs-memory-store.ts";

describe("session output route error boundaries", () => {
  it("reports a missing immutable payload as a server error and ignores another method", async () => {
    const plane = new ControlPlane();
    const now = new Date().toISOString();
    plane.state.sessions.set("corrupt-payload", {
      id: "corrupt-payload",
      repositoryId: "repo",
      status: "completed",
      createdAt: now,
      completedAt: now,
      attemptId: "attempt",
      hostId: "host",
      resolvedRoute: { hostId: "host", attemptId: "attempt" },
      sessionOutputsSupported: true,
    } as SessionRecord);
    const store = new (class extends MemorySessionOutputsStore {
      override async getPayload() {
        return null;
      }
    })(plane.state);
    const jsonText = "true";
    await store.prepare(
      "corrupt-payload",
      {
        attemptId: "attempt",
        capturedAt: now,
        output: {
          state: "ready",
          jsonText,
          sha256: createHash("sha256").update(jsonText).digest("hex"),
        },
        artifacts: { state: "none" },
      },
      "host",
      now,
    );
    const artifacts = new LocalSessionArtifactStore(
      await mkdtemp(join(tmpdir(), "ah-route-errors-")),
    );
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleSessionOutputRoutes(
        { plane, req, res, url, method: req.method ?? "GET" },
        store,
        artifacts,
        "http://127.0.0.1",
      ).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const url = `http://127.0.0.1:${port}/api/v1/sessions/corrupt-payload/output`;
      expect((await fetch(url)).status).toBe(500);
      expect((await fetch(url, { method: "PATCH" })).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
