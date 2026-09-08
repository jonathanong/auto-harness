import { afterEach, describe, expect, it } from "vitest";

import {
  apiGet,
  apiGetFirstMatchingPage,
  apiGetFirstNonEmptyPage,
  hostId,
  setApiTransportForTests,
} from "./api.ts";

const originalHostId = process.env.HARNESS_HOST_ID;
const originalPublicHostId = process.env.NEXT_PUBLIC_HARNESS_HOST_ID;

afterEach(() => {
  setApiTransportForTests(undefined);
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
  if (originalPublicHostId === undefined) delete process.env.NEXT_PUBLIC_HARNESS_HOST_ID;
  else process.env.NEXT_PUBLIC_HARNESS_HOST_ID = originalPublicHostId;
  Reflect.deleteProperty(globalThis, "window");
});

describe("host pane API branch coverage", () => {
  it("skips request header forwarding in a browser runtime", async () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    let receivedInit: RequestInit | undefined;
    setApiTransportForTests(async (_input, init) => {
      receivedInit = init;
      return Response.json({ ok: true });
    });

    await expect(apiGet<{ ok: boolean }>("/api/v1/test")).resolves.toEqual({ ok: true });
    expect(receivedInit).toEqual({ cache: "no-store" });
  });

  it("falls back through the public and local host identifiers", () => {
    delete process.env.HARNESS_HOST_ID;
    process.env.NEXT_PUBLIC_HARNESS_HOST_ID = " public-host ";
    expect(hostId()).toBe("public-host");

    process.env.NEXT_PUBLIC_HARNESS_HOST_ID = " ";
    expect(hostId()).toBe("local-1");
  });

  it("skips sparse pages until the first page with items", async () => {
    const paths: string[] = [];
    setApiTransportForTests(async (input) => {
      paths.push(String(input));
      return Response.json(
        paths.length === 1
          ? { items: [], nextCursor: "next page" }
          : { items: [{ id: "found" }], nextCursor: "later" },
      );
    });

    await expect(
      apiGetFirstNonEmptyPage<{ id: string }>("/api/v1/sessions?limit=100"),
    ).resolves.toEqual([{ id: "found" }]);
    expect(
      paths.map((path) => {
        const url = new URL(path);
        return `${url.pathname}${url.search}`;
      }),
    ).toEqual(["/api/v1/sessions?limit=100", "/api/v1/sessions?limit=100&cursor=next%20page"]);
  });

  it("returns an empty terminal page", async () => {
    setApiTransportForTests(async () => Response.json({ items: [] }));
    await expect(apiGetFirstNonEmptyPage("/api/v1/sessions")).resolves.toEqual([]);
  });

  it("skips pages without a matching item", async () => {
    let page = 0;
    setApiTransportForTests(async () => {
      page += 1;
      return Response.json(
        page === 1
          ? { items: [{ id: "other" }], nextCursor: "next" }
          : { items: [{ id: "found" }, { id: "other" }], nextCursor: "later" },
      );
    });
    await expect(
      apiGetFirstMatchingPage<{ id: string }>("/api/v1/sessions", (item) => item.id === "found"),
    ).resolves.toEqual([{ id: "found" }]);
  });

  it("rejects a repeated sparse cursor", async () => {
    setApiTransportForTests(async () => Response.json({ items: [], nextCursor: "same" }));
    await expect(apiGetFirstNonEmptyPage("/api/v1/sessions")).rejects.toThrow(
      "repeated pagination cursor",
    );
  });

  it("bounds a permanently sparse response", async () => {
    let page = 0;
    setApiTransportForTests(async () => {
      page += 1;
      return Response.json({ items: [], nextCursor: `next-${page}` });
    });
    await expect(apiGetFirstNonEmptyPage("/api/v1/sessions")).rejects.toThrow(
      "pagination exceeded 20 pages",
    );
  });
});
