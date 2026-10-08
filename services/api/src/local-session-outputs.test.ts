/* eslint-disable max-lines -- output upload/read flows share one live HTTP server fixture. */
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { SessionRecord } from "./db/types.ts";
import { startLocalServer } from "./local-server.ts";
import { LocalSessionArtifactStore } from "./session-artifact-store.ts";

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function session(id: string, fields: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 60,
    queueExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    completedAt: new Date(Date.now() - 1000).toISOString(),
    attemptId: "attempt",
    hostId: "host",
    resolvedRoute: {
      hostId: "host",
      attemptId: "attempt",
      commandId: "cmd",
      targetIndex: 0,
      worktreeId: null,
    },
    sessionOutputsSupported: true,
    ...fields,
  };
}

function postPrepare(base: string, id: string, value: unknown) {
  return fetch(`${base}/api/v1/sessions/${id}/outputs/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("local session output publication and reads", () => {
  let base: string;
  let close: () => Promise<void>;
  let plane: ControlPlane;
  let local: LocalSessionArtifactStore;

  beforeAll(async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), "ah-output-http-"));
    local = new LocalSessionArtifactStore(dir);
    plane = new ControlPlane();
    const started = await startLocalServer({
      port,
      useDynamo: false,
      authMode: "disabled",
      plane,
      sessionArtifactStore: local,
      enableWs: false,
    });
    base = `http://127.0.0.1:${port}`;
    close = started.close;
  });
  afterAll(async () => {
    await close?.();
  });

  it("returns unsupported/pending independently and publishes immutable null plus signed gzip", async () => {
    plane.state.sessions.set("legacy", session("legacy", { sessionOutputsSupported: false }));
    expect(await (await fetch(`${base}/api/v1/sessions/legacy/output`)).json()).toEqual({
      state: "unsupported",
    });
    plane.state.sessions.set("sess", session("sess"));
    expect(await (await fetch(`${base}/api/v1/sessions/sess/output`)).json()).toEqual({
      state: "pending",
    });
    const bytes = Buffer.from("gzip bytes");
    const jsonText = "null";
    const request = {
      attemptId: "attempt",
      capturedAt: new Date().toISOString(),
      output: {
        state: "ready",
        jsonText,
        sha256: createHash("sha256").update(jsonText).digest("hex"),
      },
      artifacts: {
        state: "pending",
        compressedBytes: bytes.length,
        sourceBytes: 18,
        fileCount: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    const prepared = await fetch(`${base}/api/v1/sessions/sess/outputs/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(prepared.status).toBe(200);
    const { artifactUpload } = (await prepared.json()) as {
      artifactUpload: { method: string; url: string; headers: Record<string, string> };
    };
    expect(artifactUpload.method).toBe("PUT");
    expect(await (await fetch(`${base}/api/v1/sessions/sess/output`)).text()).toContain(
      '"output":null',
    );
    expect(await (await fetch(`${base}/api/v1/sessions/sess/artifacts`)).json()).toEqual({
      state: "pending",
    });
    const upload = await fetch(artifactUpload.url, {
      method: "PUT",
      headers: artifactUpload.headers,
      body: bytes,
    });
    expect(upload.status).toBe(200);
    const complete = await fetch(`${base}/api/v1/sessions/sess/outputs/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId: "attempt" }),
    });
    expect(complete.status).toBe(200);
    const artifacts = (await (await fetch(`${base}/api/v1/sessions/sess/artifacts`)).json()) as {
      state: string;
      downloadUrl: string;
      expiresAt: string;
    };
    expect(artifacts.state).toBe("ready");
    expect(new URL(artifacts.downloadUrl).searchParams.get("expires")).toBe(
      String(Date.parse(artifacts.expiresAt)),
    );
    const download = await fetch(artifacts.downloadUrl);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect(download.headers.get("cache-control")).toBe("no-store");
    const tampered = new URL(artifacts.downloadUrl);
    tampered.searchParams.set("version", "wrong");
    expect((await fetch(tampered)).status).toBe(404);
    plane.state.sessions.get("sess")!.retentionToken = "claimed";
    expect((await fetch(artifacts.downloadUrl)).status).toBe(404);
  });

  it("preserves deep JSON source text and distinguishes no artifact from output error", async () => {
    plane.state.sessions.set("deep", session("deep"));
    const jsonText = "[".repeat(1024) + "1e400" + "]".repeat(1024);
    const request = {
      attemptId: "attempt",
      capturedAt: new Date().toISOString(),
      output: {
        state: "ready",
        jsonText,
        sha256: createHash("sha256").update(jsonText).digest("hex"),
      },
      artifacts: { state: "none" },
    };
    expect(
      (
        await fetch(`${base}/api/v1/sessions/deep/outputs/prepare`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(200);
    const raw = await (await fetch(`${base}/api/v1/sessions/deep/output`)).text();
    expect(raw).toContain(`"output":${jsonText}`);
    expect(await (await fetch(`${base}/api/v1/sessions/deep/artifacts`)).json()).toEqual({
      state: "none",
    });
  });

  it("retries unsettled hooks and rejects changed manifest with a stable conflict code", async () => {
    plane.state.sessions.set(
      "hook",
      session("hook", {
        terminalHookHandoff: {
          handoffId: "handoff",
          attemptId: "attempt",
          hostId: "host",
          repositoryId: "repo",
          worktreeId: null,
          status: "completed",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );
    const body = {
      attemptId: "attempt",
      capturedAt: new Date().toISOString(),
      output: { state: "none" },
      artifacts: { state: "none" },
    };
    expect(await (await postPrepare(base, "hook", body)).json()).toMatchObject({
      error: { code: "OUTPUTS_NOT_SETTLED" },
    });
    delete plane.state.sessions.get("hook")!.terminalHookHandoff;
    expect((await postPrepare(base, "hook", body)).status).toBe(200);
    expect(
      await (
        await postPrepare(base, "hook", {
          ...body,
          capturedAt: new Date(Date.now() + 1000).toISOString(),
        })
      ).json(),
    ).toMatchObject({ error: { code: "OUTPUT_CONFLICT" } });
  });

  it("validates submissions and exposes independent error and expired states", async () => {
    expect((await fetch(`${base}/api/v1/sessions/missing/output`)).status).toBe(404);
    expect((await postPrepare(base, "missing", { attemptId: "attempt" })).status).toBe(400);
    plane.state.sessions.set("errors", session("errors"));
    expect((await postPrepare(base, "errors", { attemptId: "attempt" })).status).toBe(400);
    expect(
      (
        await fetch(`${base}/api/v1/sessions/errors/outputs/prepare`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{invalid",
        })
      ).status,
    ).toBe(400);
    const request = {
      attemptId: "attempt",
      capturedAt: new Date().toISOString(),
      output: { state: "error", error: { code: "NO_FILE", message: "missing output" } },
      artifacts: { state: "error", error: { code: "NO_DIR", message: "missing artifacts" } },
    };
    expect((await postPrepare(base, "errors", request)).status).toBe(200);
    expect(await (await fetch(`${base}/api/v1/sessions/errors/output`)).json()).toMatchObject({
      state: "error",
      error: { code: "NO_FILE" },
    });
    expect(await (await fetch(`${base}/api/v1/sessions/errors/artifacts`)).json()).toMatchObject({
      state: "error",
      error: { code: "NO_DIR" },
    });
    expect((await postPrepare(base, "missing", request)).status).toBe(404);
    expect(
      (
        await fetch(`${base}/api/v1/sessions/errors/outputs/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{bad",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/api/v1/sessions/errors/outputs/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    plane.state.sessions.set(
      "expired",
      session("expired", { completedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }),
    );
    expect(await (await fetch(`${base}/api/v1/sessions/expired/output`)).json()).toMatchObject({
      state: "error",
      error: { code: "OUTPUTS_UNAVAILABLE" },
    });
  });

  it("rejects unprepared, unauthenticated and corrupted local artifact transfers", async () => {
    const id = "integrity";
    plane.state.sessions.set(id, session(id));
    const bytes = Buffer.from("gzip bytes for integrity");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploadPath = `${base}/api/v1/sessions/${id}/outputs/upload/attempt`;
    expect((await fetch(uploadPath, { method: "PUT", body: bytes })).status).toBe(409);
    const prepared = await postPrepare(base, id, {
      attemptId: "attempt",
      capturedAt: new Date().toISOString(),
      output: { state: "none" },
      artifacts: {
        state: "pending",
        compressedBytes: bytes.length,
        sourceBytes: bytes.length,
        fileCount: 1,
        sha256,
      },
    });
    const { artifactUpload } = (await prepared.json()) as {
      artifactUpload: { url: string; headers: Record<string, string> };
    };
    expect((await fetch(uploadPath, { method: "PUT", body: bytes })).status).toBe(403);
    expect((await fetch(artifactUpload.url, { method: "PUT", body: bytes })).status).toBe(400);
    expect(
      await (
        await fetch(`${base}/api/v1/sessions/${id}/outputs/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attemptId: "attempt" }),
        })
      ).json(),
    ).toMatchObject({ error: { code: "OUTPUTS_NOT_UPLOADED" } });
    expect(
      (
        await fetch(artifactUpload.url, {
          method: "PUT",
          headers: artifactUpload.headers,
          body: Buffer.from("wrong bytes but same length"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(artifactUpload.url, {
          method: "PUT",
          headers: artifactUpload.headers,
          body: bytes,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/api/v1/sessions/${id}/outputs/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attemptId: "attempt" }),
        })
      ).status,
    ).toBe(200);
    const ready = (await (await fetch(`${base}/api/v1/sessions/${id}/artifacts`)).json()) as {
      downloadUrl: string;
    };
    const file = join(
      local.directory,
      createHash("sha256").update(`${id}\0attempt`).digest("hex") + ".tar.gz",
    );
    await writeFile(file, "changed on disk");
    expect((await fetch(ready.downloadUrl)).status).toBe(404);
  });
});
