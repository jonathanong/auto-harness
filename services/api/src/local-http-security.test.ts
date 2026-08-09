import { describe, expect, it } from "vitest";

import { readJson, send } from "./local-http.ts";

describe("local HTTP limits", () => {
  it("rejects oversized JSON bodies", async () => {
    let destroyed = false;
    const req = {
      on(event: string, callback: (chunk?: Buffer) => void) {
        if (event === "data") callback(Buffer.alloc(1024 * 1024 + 1));
        if (event === "end") callback();
        return req;
      },
      destroy() {
        destroyed = true;
      },
    };
    await expect(readJson(req as never)).rejects.toThrow("exceeds 1 MiB");
    expect(destroyed).toBe(true);
  });

  it("treats an empty body as an empty object", async () => {
    const req = {
      on(event: string, callback: () => void) {
        if (event === "end") callback();
        return req;
      },
    };
    await expect(readJson(req as never)).resolves.toEqual({});
  });

  it("supports minimal response fakes and no-content responses", () => {
    let written = "";
    const heads: number[] = [];
    const res = {
      writeHead(status: number) {
        heads.push(status);
      },
      end(payload?: string) {
        written = payload ?? "";
      },
    };
    send(res as never, 200, { ok: true });
    expect(written).toBe(JSON.stringify({ ok: true }));
    send(res as never, 204, null);
    expect(heads).toEqual([200, 204]);
  });
});
