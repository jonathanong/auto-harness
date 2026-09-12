import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const admins = () =>
  Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString("base64url");

/**
 * The archive route resolved its session from the process cache, so the scope check
 * disappeared whenever this worker had not seen the session — the ordinary case on a
 * fresh worker. The response also echoed the whole transcript, which made the miss a
 * read of any session's logs rather than a failed lookup.
 */
async function harness() {
  const downloads: string[] = [];
  const plane = new ControlPlane({
    idFactory: (() => {
      let n = 0;
      return () => `session-${++n}`;
    })(),
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
  plane.createRepository({ id: "repo-a", name: "repo-a", url: "https://example.test/a.git" });
  plane.createRepository({ id: "repo-b", name: "repo-b", url: "https://example.test/b.git" });
  plane.createCommand({ id: "cmd-a", name: "echo", argv: ["echo"], providerId: null });
  plane.createSession({
    repositoryId: "repo-a",
    prompt: "a",
    target: { commandId: "cmd-a" },
    timeout: 10,
  });
  plane.createSession({
    repositoryId: "repo-b",
    prompt: "b",
    target: { commandId: "cmd-a" },
    timeout: 10,
  });
  const own = plane.listSessions().find((session) => session.repositoryId === "repo-a")!;
  const other = plane.listSessions().find((session) => session.repositoryId === "repo-b")!;
  plane.state.sessions.set(own.id, { ...own, status: "completed" });

  const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
  const { apiKey } = await auth.createServiceAccount({
    name: "scoped-agent",
    role: "operator",
    allowedRepositoryIds: ["repo-a"],
  });
  const { apiKey: hostApiKey } = await auth.createServiceAccount({
    name: "host-agent",
    role: "agent",
    allowedRepositoryIds: ["repo-a"],
    boundHostId: "host-a",
  });
  const { handler } = createLocalApp({
    plane,
    authService: auth,
    rateLimitConfig: { enabled: false },
  });
  const invoke = (method: string, path: string) =>
    invokeHandler(handler, method, path, undefined, { authorization: `Bearer ${apiKey}` });
  const invokeAsHost = (method: string, path: string) =>
    invokeHandler(handler, method, path, undefined, { authorization: `Bearer ${hostApiKey}` });

  return { plane, invoke, invokeAsHost, own, other, downloads };
}

describe("POST /api/v1/sessions/:id/archive", () => {
  it("refuses an out-of-scope session that is absent from the process cache", async () => {
    const { plane, invoke, other } = await harness();
    plane.state.logs.set(other.id, [
      {
        sessionId: other.id,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000000",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 0,
        stream: "stdout",
        content: "cross-repository-secret",
      },
    ]);
    // Evict only the session record. The logs stay reachable, which is exactly the state
    // a worker that never scheduled this session is in.
    plane.state.sessions.delete(other.id);

    const res = await invoke("POST", `/api/v1/sessions/${other.id}/archive`);

    expect(res.status).toBe(404);
    expect(res.raw).not.toContain("cross-repository-secret");
  });

  it("returns archive metadata without the transcript body", async () => {
    const { plane, invoke, own } = await harness();
    plane.state.logs.set(own.id, [
      {
        sessionId: own.id,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000000",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 0,
        stream: "stdout",
        content: "in-scope-output",
      },
    ]);

    const res = await invoke("POST", `/api/v1/sessions/${own.id}/archive`);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      key: `sessions/${own.id}/logs.jsonl`,
      contentType: "application/x-ndjson",
    });
    expect((res.json as { bodyBytes: number }).bodyBytes).toBeGreaterThan(0);
    expect(res.json).not.toHaveProperty("body");
    expect(res.raw).not.toContain("in-scope-output");
  });

  it("404s an unknown session instead of archiving it", async () => {
    const { invoke } = await harness();

    expect((await invoke("POST", "/api/v1/sessions/missing/archive")).status).toBe(404);
  });

  it("fails closed when cancel and archive outcome audits cannot be stored", async () => {
    const { plane, invoke, own, other } = await harness();
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };

    expect((await invoke("POST", `/api/v1/sessions/${other.id}/cancel`)).status).toBe(500);
    expect((await invoke("POST", "/api/v1/sessions/missing/cancel")).status).toBe(500);
    expect((await invoke("POST", `/api/v1/sessions/${own.id}/archive`)).status).toBe(500);
  });
});

describe("GET /api/v1/sessions/:id/archive", () => {
  it("returns a verified download without caching the signed URL", async () => {
    const { plane, invoke, own, downloads } = await harness();
    plane.state.archives.set(`sessions/${own.id}/logs.jsonl`, {
      key: `sessions/${own.id}/logs.jsonl`,
      versionId: "archive-v1",
      objectKey: "sessions/another-session/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await invoke("GET", `/api/v1/sessions/${own.id}/archive`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json).toEqual({
      state: "archived",
      downloadUrl: "https://archive.example.test/signed",
      expiresAt: "2026-01-01T00:05:00.000Z",
      contentType: "application/x-ndjson",
      bodyBytes: 42,
    });
    expect(downloads).toEqual([`sessions/${own.id}/logs.jsonl`]);
  });

  it("distinguishes recent and unavailable transcripts", async () => {
    const { plane, invoke, own } = await harness();
    const path = `/api/v1/sessions/${own.id}/archive`;
    await expect(invoke("GET", path)).resolves.toMatchObject({
      status: 200,
      json: { state: "dynamodb" },
    });
    plane.state.archives.set(`sessions/${own.id}/logs.jsonl`, {
      key: `sessions/${own.id}/logs.jsonl`,
      versionId: "archive-v1",
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "complete",
      objectStored: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(invoke("GET", path)).resolves.toMatchObject({
      status: 200,
      json: { state: "unavailable" },
    });
  });

  it("does not probe S3 for unknown or out-of-scope sessions", async () => {
    const { invoke, other, downloads } = await harness();

    expect((await invoke("GET", `/api/v1/sessions/${other.id}/archive`)).status).toBe(404);
    expect((await invoke("GET", "/api/v1/sessions/missing/archive")).status).toBe(404);
    expect(downloads).toEqual([]);
  });

  it("applies host binding before probing S3", async () => {
    const { plane, invokeAsHost, own, downloads } = await harness();
    const record = plane.state.sessions.get(own.id)!;
    plane.state.sessions.set(own.id, { ...record, hostId: "host-b" });
    plane.state.archives.set(`sessions/${own.id}/logs.jsonl`, {
      key: `sessions/${own.id}/logs.jsonl`,
      versionId: "archive-v1",
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await invokeAsHost("GET", `/api/v1/sessions/${own.id}/archive`)).status).toBe(404);
    expect(downloads).toEqual([]);
  });

  it("returns a structured 500 when durable archive metadata fails", async () => {
    const { plane, invoke, own } = await harness();
    plane.state.storage = {
      getSession: async () => plane.state.sessions.get(own.id)!,
      getArchive: async () => Promise.reject(new Error("storage unavailable")),
    } as never;

    const res = await invoke("GET", `/api/v1/sessions/${own.id}/archive`);
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
