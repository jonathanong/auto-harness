import { describe, expect, it } from "vitest";

import { resolveArtifactApiBaseUrl } from "./local-http.ts";

describe("local artifact API origin", () => {
  it("uses the reachable bind by default and loopback for wildcard bind", () => {
    expect(resolveArtifactApiBaseUrl({ host: "192.0.2.10", port: 8111 })).toBe(
      "http://192.0.2.10:8111",
    );
    expect(resolveArtifactApiBaseUrl({ host: "0.0.0.0", port: 8111 })).toBe(
      "http://127.0.0.1:8111",
    );
  });

  it("accepts an explicit HTTPS origin and rejects paths or embedded credentials", () => {
    expect(resolveArtifactApiBaseUrl({ apiPublicBaseUrl: "https://api.example.test:8443" })).toBe(
      "https://api.example.test:8443",
    );
    expect(() =>
      resolveArtifactApiBaseUrl({ apiPublicBaseUrl: "https://api.example.test/base" }),
    ).toThrow("HTTP(S) origin");
    expect(() =>
      resolveArtifactApiBaseUrl({ apiPublicBaseUrl: "https://u:p@api.example.test" }),
    ).toThrow("HTTP(S) origin");
  });
});
