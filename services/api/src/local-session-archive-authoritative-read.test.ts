import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { createAuthoritativeReadStorage } from "../test-helpers/control-plane-authoritative-read-test-helpers.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

describe("durable session archive reads", () => {
  it("reads archive metadata durably on a fresh worker", async () => {
    const storage = createAuthoritativeReadStorage();
    const writer = new ControlPlane({
      storage,
      commandIdFactory: () => "command",
      idFactory: () => "session",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect((await writer.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
    expect(
      (
        await writer.createSessionDurable({
          repositoryId: "repository",
          prompt: "work",
          target: { commandId: "command" },
          timeout: 1,
        })
      ).ok,
    ).toBe(true);
    const persistedSession = writer.state.sessions.get("session")!;
    await writer.state.storage!.createSession({ ...persistedSession, status: "completed" });
    await writer.state.storage!.putArchive({
      key: "sessions/session/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 17,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const reader = new ControlPlane({
      storage,
      archiveReader: {
        createDownload: async () => ({
          available: true,
          downloadUrl: "https://archive.example.test/fresh",
          expiresAt: "2026-01-01T00:05:00.000Z",
        }),
      },
    });
    expect(reader.state.archives.size).toBe(0);

    const { handler } = createLocalApp({ plane: reader });
    const response = await invokeHandler(handler, "GET", "/api/v1/sessions/session/archive");

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      state: "archived",
      downloadUrl: "https://archive.example.test/fresh",
      bodyBytes: 17,
    });
    expect(reader.state.archives.get("sessions/session/logs.jsonl")).toMatchObject({
      status: "complete",
    });
  });

  it.each(["queued", "running"] as const)(
    "does not expose a completed archive while a session is %s",
    async (status) => {
      const downloads: string[] = [];
      const plane = new ControlPlane({
        archiveReader: {
          createDownload: async ({ key }) => {
            downloads.push(key);
            return {
              available: true,
              downloadUrl: "https://archive.example.test/signed",
              expiresAt: "2026-01-01T00:05:00.000Z",
            };
          },
        },
      });
      plane.createRepository({ id: "repository", name: "repository", url: "https://example.test" });
      plane.createCommand({ id: "command", name: "echo", argv: ["echo"], providerId: null });
      const created = plane.createSession({
        repositoryId: "repository",
        prompt: "work",
        target: { commandId: "command" },
        timeout: 1,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const session = created.session;
      plane.state.sessions.set(session.id, { ...session, status });
      plane.state.archives.set(`sessions/${session.id}/logs.jsonl`, {
        key: `sessions/${session.id}/logs.jsonl`,
        contentType: "application/x-ndjson",
        bodyBytes: 0,
        status: "complete",
        objectStored: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const { handler } = createLocalApp({ plane });
      const response = await invokeHandler(
        handler,
        "GET",
        `/api/v1/sessions/${session.id}/archive`,
      );

      expect(response.status).toBe(200);
      expect(response.json).toEqual({ state: "dynamodb" });
      expect(downloads).toEqual([]);
    },
  );
});
