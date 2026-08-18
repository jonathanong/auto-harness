import { describe, expect, it } from "vitest";

import { resolveWsUrl } from "./ws-url.ts";

describe("resolveWsUrl", () => {
  it("converts an http base with no path to ws and appends /ws", () => {
    expect(resolveWsUrl("http://127.0.0.1:7420")).toBe("ws://127.0.0.1:7420/ws");
  });

  it("converts an http base with a trailing slash to ws and appends /ws", () => {
    expect(resolveWsUrl("http://127.0.0.1:7420/")).toBe("ws://127.0.0.1:7420/ws");
  });

  it("leaves an explicit ws /ws path untouched", () => {
    expect(resolveWsUrl("ws://127.0.0.1:7420/ws")).toBe("ws://127.0.0.1:7420/ws");
  });

  it("converts an https CloudFront base with no path to wss and appends /ws", () => {
    expect(resolveWsUrl("https://d111.cloudfront.net")).toBe("wss://d111.cloudfront.net/ws");
  });

  it("appends /ws for a host whose name happens to start with ws (defect-2 regression)", () => {
    // The old check was `url.includes("/ws")`, a substring test on the whole URL — the "//ws"
    // in "wss://ws.example.com" matched it, so the append was wrongly skipped.
    expect(resolveWsUrl("wss://ws.example.com")).toBe("wss://ws.example.com/ws");
  });

  it("does not append /ws when an explicit path is already present (defect-2 regression)", () => {
    // The old check also false-negatived: "/workspaces" contains the substring "/ws", so the
    // append was (accidentally, correctly) skipped. The new pathname check gets there on
    // purpose: any explicit path is left alone.
    expect(resolveWsUrl("https://host/workspaces")).toBe("wss://host/workspaces");
  });

  it("passes through an explicit non-/ws path unchanged (scheme aside)", () => {
    expect(resolveWsUrl("https://host/custom/path")).toBe("wss://host/custom/path");
  });

  it("rejects a raw API Gateway WebSocket endpoint by default", () => {
    expect(() =>
      resolveWsUrl("wss://vyhm4qwtsk.execute-api.us-west-2.amazonaws.com/prod"),
    ).toThrowError(/WebUrl/);
  });

  it("names the offending URL and the CloudFront alternative in the API Gateway error", () => {
    const url = "wss://vyhm4qwtsk.execute-api.us-west-2.amazonaws.com/prod";
    expect(() => resolveWsUrl(url)).toThrowError(new RegExp(`${url}.*WebUrl`, "su"));
  });

  it("allows a raw API Gateway endpoint when explicitly opted in (--ws escape hatch)", () => {
    expect(
      resolveWsUrl("wss://vyhm4qwtsk.execute-api.us-west-2.amazonaws.com/prod", {
        allowApiGatewayEndpoint: true,
      }),
    ).toBe("wss://vyhm4qwtsk.execute-api.us-west-2.amazonaws.com/prod");
  });

  it("does not flag a hostname that merely contains, but does not end with, the execute-api suffix", () => {
    expect(resolveWsUrl("https://execute-api.amazonaws.com.evil.test")).toBe(
      "wss://execute-api.amazonaws.com.evil.test/ws",
    );
  });

  it("rethrows with the original input for an unparseable URL", () => {
    expect(() => resolveWsUrl("not a url")).toThrowError(/not a url/);
  });
});
