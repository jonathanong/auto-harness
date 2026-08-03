import { describe, expect, it } from "vitest";

import { createLocalApp } from "./local-server.ts";
import { MemorySessionStore } from "./memory-store.ts";

describe("createLocalApp health and sessions", () => {
  it("handles health, create, get, list, and 404s", async () => {
    const store = new MemorySessionStore({
      idFactory: () => "sess-1",
      now: () => "t0",
      publicBaseUrl: "http://ui",
    });
    const { handler } = createLocalApp({ store });

    const invoke = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: unknown }> => {
      const chunks: Buffer[] = [];
      let statusCode = 0;
      const req = {
        method,
        url: path,
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data" && body !== undefined) {
            cb(Buffer.from(JSON.stringify(body)));
          }
          if (event === "end") {
            cb();
          }
          return req;
        },
      };
      const res = {
        writeHead(code: number) {
          statusCode = code;
        },
        end(payload: string) {
          chunks.push(Buffer.from(payload));
        },
      };
      await handler(req as never, res as never);
      return {
        status: statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
    };

    expect((await invoke("GET", "/health")).json).toEqual({ ok: true });
    const created = await invoke("POST", "/api/v1/sessions", {
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "codex-fix",
      timeout: 10,
    });
    expect(created.status).toBe(201);
    expect(await invoke("GET", "/api/v1/sessions/sess-1")).toMatchObject({
      status: 200,
    });
    expect(await invoke("GET", "/api/v1/sessions")).toMatchObject({
      status: 200,
    });
    expect((await invoke("GET", "/api/v1/sessions/nope")).status).toBe(404);
    expect((await invoke("GET", "/missing")).status).toBe(404);
    expect((await invoke("POST", "/api/v1/sessions", null)).status).toBe(400);
    expect(
      (
        await invoke("POST", "/api/v1/sessions", {
          repositoryId: "",
          prompt: "p",
          commandProfile: "x",
          timeout: 1,
        })
      ).status,
    ).toBe(400);

    const badChunks: Buffer[] = [];
    let badStatus = 0;
    const badReq = {
      method: "POST",
      url: "/api/v1/sessions",
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "data") {
          cb(Buffer.from("{not-json"));
        }
        if (event === "end") {
          cb();
        }
        return badReq;
      },
    };
    const badRes = {
      writeHead(code: number) {
        badStatus = code;
      },
      end(payload: string) {
        badChunks.push(Buffer.from(payload));
      },
    };
    await handler(badReq as never, badRes as never);
    expect(badStatus).toBe(400);

    let emptyStatus = 0;
    const emptyReq = {
      method: "POST",
      url: "/api/v1/sessions",
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "end") {
          cb();
        }
        return emptyReq;
      },
    };
    const emptyRes = {
      writeHead(code: number) {
        emptyStatus = code;
      },
      end() {
        /* empty */
      },
    };
    await handler(emptyReq as never, emptyRes as never);
    expect(emptyStatus).toBe(400);
  });

  it("covers default createLocalApp store and missing method/url", async () => {
    const { handler } = createLocalApp({
      publicBaseUrl: "http://ui.example",
    });
    let status = 0;
    const req = {
      method: undefined,
      url: "/health",
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "end") {
          cb();
        }
        return req;
      },
    };
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end() {
        /* empty */
      },
    };
    await handler(req as never, res as never);
    expect(status).toBe(200);

    let status2 = 0;
    const req2 = {
      method: "GET",
      url: undefined,
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "end") {
          cb();
        }
        return req2;
      },
    };
    const res2 = {
      writeHead(code: number) {
        status2 = code;
      },
      end() {
        /* empty */
      },
    };
    await handler(req2 as never, res2 as never);
    expect(status2).toBe(404);
  });
});
