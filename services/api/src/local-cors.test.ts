import { describe, expect, it } from "vitest";

import { applyLocalCors } from "./local-cors.ts";

describe("applyLocalCors", () => {
  it("sets CORS headers for control-plane UI origin and handles OPTIONS", () => {
    const headers = new Map<string, string>();
    let status = 0;
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      writeHead(code: number) {
        status = code;
      },
      end() {
        /* empty */
      },
    };
    const handled = applyLocalCors(
      {
        method: "OPTIONS",
        headers: { origin: "http://127.0.0.1:7421" },
      } as never,
      res as never,
    );
    expect(handled).toBe(true);
    expect(status).toBe(204);
    expect(headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:7421");
    expect(headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("allows agent-pane origin on normal requests without finishing the response", () => {
    const headers = new Map<string, string>();
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      writeHead() {
        throw new Error("should not writeHead for non-OPTIONS");
      },
      end() {
        throw new Error("should not end for non-OPTIONS");
      },
    };
    const handled = applyLocalCors(
      {
        method: "GET",
        headers: { origin: "http://127.0.0.1:7422" },
      } as never,
      res as never,
    );
    expect(handled).toBe(false);
    expect(headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:7422");
  });

  it("allows any localhost port and ignores remote origins", () => {
    const headers = new Map<string, string>();
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      writeHead() {
        /* unused */
      },
      end() {
        /* unused */
      },
    };
    applyLocalCors(
      { method: "GET", headers: { origin: "http://localhost:9999" } } as never,
      res as never,
    );
    expect(headers.get("access-control-allow-origin")).toBe("http://localhost:9999");

    headers.clear();
    applyLocalCors(
      { method: "GET", headers: { origin: "https://evil.example" } } as never,
      res as never,
    );
    expect(headers.has("access-control-allow-origin")).toBe(false);
  });

  it("ignores non-http(s) protocols and unparseable origins", () => {
    const headers = new Map<string, string>();
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      writeHead() {
        /* unused */
      },
      end() {
        /* unused */
      },
    };
    applyLocalCors(
      { method: "GET", headers: { origin: "file://localhost/etc/passwd" } } as never,
      res as never,
    );
    expect(headers.has("access-control-allow-origin")).toBe(false);

    applyLocalCors({ method: "GET", headers: { origin: "not-a-url" } } as never, res as never);
    expect(headers.has("access-control-allow-origin")).toBe(false);
  });
});
