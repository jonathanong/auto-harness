import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { queueWrite } from "./control-plane-state.ts";
import { createLambdaRuntime } from "./lambda-handlers.ts";
import { createLambdaResponseCapture, requestForLambdaEvent } from "./lambda-http-adapter.ts";

describe("Lambda HTTP adapter", () => {
  it("translates HTTP API requests and responses through the shared REST router", async () => {
    const runtime = await createLambdaRuntime({
      auth: {} as never,
      created: { plane: new ControlPlane(), storage: {} } as never,
      management: { send: async () => ({}) },
    });

    const event = {
      body: Buffer.from("ignored").toString("base64"),
      cookies: ["one=1", "two=2"],
      headers: { "X-Test": "yes", ignored: undefined },
      isBase64Encoded: true,
      rawPath: "/health",
      rawQueryString: "verbose=1",
      requestContext: { http: { method: "GET", sourceIp: "203.0.113.7" } },
    };
    const request = requestForLambdaEvent(event);
    expect(request.headers).toEqual({ "x-test": "yes", cookie: "one=1; two=2" });
    expect(request.socket.remoteAddress).toBe("203.0.113.7");
    await expect(runtime.rest(event)).resolves.toMatchObject({
      statusCode: 200,
      body: '{"ok":true}',
      headers: { "content-type": "application/json" },
    });
    await expect(runtime.rest({ rawPath: "/health" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      runtime.rest({ body: "plain", rawPath: "/health", requestContext: { http: {} } }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it("defaults the logged path to an empty string when the event omits rawPath", async () => {
    const runtime = await createLambdaRuntime({
      auth: {} as never,
      created: { plane: new ControlPlane(), storage: {} } as never,
      management: { send: async () => ({}) },
    });
    await expect(runtime.rest({})).resolves.toMatchObject({ statusCode: 404 });
  });

  it("logs and rethrows when translating the Lambda event fails", async () => {
    const runtime = await createLambdaRuntime({
      auth: {} as never,
      created: { plane: new ControlPlane(), storage: {} } as never,
      management: { send: async () => ({}) },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runtime.rest({ body: 123, rawPath: "/health" } as never)).rejects.toThrow(
      "must be of type string",
    );
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      msg: "rest failure",
      method: "UNKNOWN",
      path: "/health",
    });
    error.mockRestore();
  });

  it("flushes pending durable writes before returning from an invocation", async () => {
    const plane = new ControlPlane();
    let released = false;
    let resolveWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    queueWrite(plane.state, async () => {
      await write;
      released = true;
    });
    const runtime = await createLambdaRuntime({
      auth: {} as never,
      created: { plane, storage: {} } as never,
      management: { send: async () => ({}) },
    });
    const rest = runtime.rest({ rawPath: "/health" });
    await Promise.resolve();
    expect(released).toBe(false);
    resolveWrite();
    await expect(rest).resolves.toMatchObject({ statusCode: 200 });
    expect(released).toBe(true);
    expect(plane.state.pendingPersists).toHaveLength(0);
  });

  it("logs a failed durable write without changing the captured HTTP response", async () => {
    const plane = new ControlPlane();
    queueWrite(plane.state, async () => {
      throw new Error("write failed");
    });
    const runtime = await createLambdaRuntime({
      auth: {} as never,
      created: { plane, storage: {} } as never,
      management: { send: async () => ({}) },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runtime.rest({ rawPath: "/health" })).resolves.toMatchObject({ statusCode: 200 });
    expect(error).toHaveBeenCalledWith(
      "durable write failed after invocation",
      expect.objectContaining({ message: "write failed" }),
    );
    error.mockRestore();
  });

  it("captures response headers, cookies, empty bodies, and arrays", () => {
    const capture = createLambdaResponseCapture();
    capture.response.writeHead(204, {
      "set-cookie": ["one=1", "two=2"],
      vary: ["origin", "authorization"],
    });
    capture.response.end();
    expect(capture.result()).toEqual({
      statusCode: 204,
      cookies: ["one=1", "two=2"],
      headers: { vary: "origin,authorization" },
    });
    expect(requestForLambdaEvent({ rawQueryString: "only=query" }).url).toBe("/?only=query");
    expect(requestForLambdaEvent({}).socket.remoteAddress).toBe("0.0.0.0");
    const scalarCookie = createLambdaResponseCapture();
    scalarCookie.response.setHeader("set-cookie", "one=1");
    expect(scalarCookie.result().cookies).toEqual(["one=1"]);
  });
});
