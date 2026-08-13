import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
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
