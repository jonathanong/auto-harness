import { describe, expect, it } from "vitest";

import { controlPlaneUrl } from "./control-plane-url.ts";

describe("controlPlaneUrl", () => {
  it("uses an explicit override when configured", () => {
    const original = process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
    process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL = "http://127.0.0.1:7420";
    expect(controlPlaneUrl()).toBe("http://127.0.0.1:7420");
    if (original === undefined) delete process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
    else process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL = original;
  });

  it("falls back to a local default on the server, and the browser origin in the browser", () => {
    const original = process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
    const originalWindow = globalThis.window;
    delete process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
    delete (globalThis as { window?: unknown }).window;
    expect(controlPlaneUrl()).toBe("http://127.0.0.1:7420");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://d111.cloudfront.net" } },
    });
    expect(controlPlaneUrl()).toBe("https://d111.cloudfront.net");
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (original === undefined) delete process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL;
    else process.env.NEXT_PUBLIC_HARNESS_CONTROL_PLANE_URL = original;
  });
});
