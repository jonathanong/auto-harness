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
      const principal =
        req.headers["x-test-principal"] === "unbound"
          ? {
              id: "operator",
              username: "operator",
              role: "operator" as const,
              kind: "user" as const,
            }
          : req.headers["x-test-principal"] === "wrong-host"
            ? {
                id: "other-host",
                username: "other-host",
                role: "operator" as const,
                kind: "service-account" as const,
                boundHostId: "other",
              }
            : req.headers["x-test-principal"] === "assigned-host"
              ? {
                  id: "assigned-host",
                  username: "assigned-host",
                  role: "operator" as const,
                  kind: "service-account" as const,
                  boundHostId: "host",
                }
              : undefined;
      void handleSessionOutputRoutes(
        { plane, req, res, url, method: req.method ?? "GET", principal },
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
      expect((await fetch(url.replace(/output$/, "unrelated"))).status).toBe(404);
      expect((await fetch(url, { headers: { "x-test-principal": "wrong-host" } })).status).toBe(
        404,
      );
      delete plane.state.sessions.get("corrupt-payload")!.hostId;
      expect(
        (
          await fetch(url.replace(/output$/, "artifacts"), {
            headers: { "x-test-principal": "assigned-host" },
          })
        ).status,
      ).toBe(200);
      const unbound = { "x-test-principal": "unbound", "content-type": "application/json" };
      expect(
        (
          await fetch(url.replace(/output$/, "outputs/prepare"), {
            method: "POST",
            headers: unbound,
            body: JSON.stringify({
              attemptId: "attempt",
              capturedAt: now,
              output: { state: "none" },
              artifacts: { state: "none" },
            }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(url.replace(/output$/, "outputs/complete"), {
            method: "POST",
            headers: unbound,
            body: JSON.stringify({ attemptId: "attempt" }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(url.replace(/output$/, "outputs/upload/attempt"), {
            method: "PUT",
            headers: unbound,
            body: "payload",
          })
        ).status,
      ).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
