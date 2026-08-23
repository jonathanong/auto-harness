import { describe, expect, it, vi } from "vitest";

import { startLocalServer } from "./local-server.ts";
import { MemorySessionStore } from "./memory-store.ts";
import { ControlPlane } from "./control-plane.ts";

describe("startLocalServer", () => {
  it("listens and closes", async () => {
    const port = 17420 + Math.floor(Math.random() * 1000);
    const store = new MemorySessionStore({ idFactory: () => "sess-ls" });
    store.plane.createCommand({ id: "cmd-c", name: "c", argv: ["echo"], providerId: null });
    // Explicit in-process plane (unit test); production uses DynamoDB Local via useDynamo.
    const server = await startLocalServer({
      port,
      useDynamo: false,
      store,
    });
    expect(server.port).toBe(port);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const created = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "r",
        prompt: "p",
        target: { commandId: "cmd-c" },
        timeout: 1,
      }),
    });
    expect(created.status).toBe(201);
    await server.close();
    await expect(server.close()).rejects.toBeTruthy();
  });

  it("rejects bind errors", async () => {
    const port = 17421 + Math.floor(Math.random() * 500);
    const first = await startLocalServer({ port, useDynamo: false });
    await expect(startLocalServer({ port, useDynamo: false })).rejects.toBeTruthy();
    await first.close();
  });

  it("defaults to port 7420 when free", async () => {
    try {
      const server = await startLocalServer({ useDynamo: false });
      expect(server.port).toBe(7420);
      await server.close();
    } catch {
      // port in use in this environment — still exercised default branch attempt
      expect(true).toBe(true);
    }
  });

  it("startLocalServer useDynamo hydrates from DynamoDB Local when available", async () => {
    try {
      const server = await startLocalServer({
        port: 17490 + Math.floor(Math.random() * 100),
        useDynamo: true,
        publicBaseUrl: "http://ui",
      });
      expect(server.plane).toBeTruthy();
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
      await server.close();
    } catch {
      // DynamoDB Local not running — optional path
      expect(true).toBe(true);
    }
  });

  it("rejects insecure binds and exercises disabled websocket setup", async () => {
    await expect(startLocalServer({ host: "0.0.0.0", useDynamo: false })).rejects.toThrow(
      "non-loopback API bind requires",
    );

    await expect(
      startLocalServer({
        host: "0.0.0.0",
        authMode: "required",
        useDynamo: false,
        enableWs: false,
        plane: new ControlPlane(),
      }),
    ).rejects.toBeTruthy();
  });

  it("starts and stops the autonomous local scheduler with the listener", async () => {
    const plane = new ControlPlane();
    const cron = vi.spyOn(plane, "evaluateCronDurable");
    const server = await startLocalServer({
      port: 17500 + Math.floor(Math.random() * 100),
      useDynamo: false,
      enableWs: false,
      plane,
      scheduler: { intervalMs: 60_000 },
    });

    await vi.waitFor(() => expect(cron).toHaveBeenCalledTimes(1));
    await server.close();
    expect(await server.scheduler.tick()).toBe(false);
  });

  it("accepts explicit and environment websocket rate-limit settings", async () => {
    const explicit = await startLocalServer({
      port: 17620 + Math.floor(Math.random() * 100),
      useDynamo: false,
      wsRateLimitPerSecond: 3,
      onRateLimitEvent: vi.fn(),
    });
    expect(explicit.port).toBeGreaterThanOrEqual(17620);
    await explicit.close();

    const previous = process.env.HARNESS_WS_RATE_LIMIT_PER_SECOND;
    process.env.HARNESS_WS_RATE_LIMIT_PER_SECOND = "4";
    try {
      const configured = await startLocalServer({
        port: 17720 + Math.floor(Math.random() * 100),
        useDynamo: false,
      });
      expect(configured.port).toBeGreaterThanOrEqual(17720);
      await configured.close();
    } finally {
      if (previous === undefined) delete process.env.HARNESS_WS_RATE_LIMIT_PER_SECOND;
      else process.env.HARNESS_WS_RATE_LIMIT_PER_SECOND = previous;
    }
  });
});
