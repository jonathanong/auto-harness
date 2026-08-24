import { afterEach, describe, expect, it } from "vitest";

import { apiGet, hostId, setApiTransportForTests } from "./api.ts";

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
});
