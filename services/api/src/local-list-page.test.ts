import { describe, expect, it } from "vitest";

import { sendListPage } from "./local-list-page.ts";

function listCtx(url: string) {
  let status = 0;
  let body = "";
  return {
    ctx: {
      url: new URL(url),
      res: {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(payload?: string) {
          body = payload ?? "";
        },
      },
    },
    result: () => ({ status, body }),
  };
}

describe("sendListPage", () => {
  it("returns 400 for an invalid limit and rethrows other paging errors", () => {
    const invalid = listCtx("http://x/list?limit=foo");
    sendListPage(invalid.ctx as never, [{ id: "a" }], (item) => item.id);
    expect(invalid.result().status).toBe(400);
    expect(invalid.result().body).toContain("VALIDATION_ERROR");

    const boom = listCtx("http://x/list");
    expect(() =>
      sendListPage(
        boom.ctx as never,
        [{ id: "a" }, { id: "b" }],
        (item) => item.id,
        () => {
          throw new Error("compare failed");
        },
      ),
    ).toThrow("compare failed");
  });
});
