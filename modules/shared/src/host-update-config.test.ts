import { describe, expect, it } from "vitest";

import { parseHostUpdateConfig } from "./host-update-config.ts";

describe("parseHostUpdateConfig", () => {
  it("accepts an enabled complete configuration and an explicit disabled override", () => {
    expect(
      parseHostUpdateConfig({
        enabled: true,
        manifestUrl: "https://updates.example.test/manifest.json",
        publicKey: "-----BEGIN PUBLIC KEY-----\r\nkey\n-----END PUBLIC KEY-----",
        installDir: "/opt/auto-harness",
        pollMs: 0,
        daemonVersion: "1.2.3",
      }),
    ).toEqual({
      enabled: true,
      manifestUrl: "https://updates.example.test/manifest.json",
      publicKey: "-----BEGIN PUBLIC KEY-----\\nkey\\n-----END PUBLIC KEY-----",
      installDir: "/opt/auto-harness",
      pollMs: 0,
      daemonVersion: "1.2.3",
    });
    expect(
      parseHostUpdateConfig({
        enabled: true,
        manifestUrl: "https://updates.example.test/manifest.json",
        publicKey: "-----BEGIN PUBLIC KEY-----\\nkey\\n-----END PUBLIC KEY-----",
      }).publicKey,
    ).toBe("-----BEGIN PUBLIC KEY-----\\nkey\\n-----END PUBLIC KEY-----");
    expect(parseHostUpdateConfig({ enabled: false })).toEqual({ enabled: false });
  });

  it("fails closed for incomplete, unsafe, or malformed settings", () => {
    const valid = {
      enabled: true,
      manifestUrl: "https://updates.example.test/manifest.json",
      publicKey: "key",
    };
    for (const input of [
      null,
      {},
      { enabled: false, manifestUrl: valid.manifestUrl },
      { enabled: true, manifestUrl: valid.manifestUrl },
      { enabled: true, publicKey: valid.publicKey },
      { ...valid, manifestUrl: "http://updates.example.test/manifest.json" },
      { ...valid, manifestUrl: "https://user:pass@updates.example.test/manifest.json" },
      { ...valid, installDir: "relative" },
      { ...valid, pollMs: -1 },
      { ...valid, pollMs: 2_147_483_648 },
      { ...valid, daemonVersion: "v1.2.3" },
      { ...valid, publicKey: "\n".repeat(16_385) },
      { ...valid, unexpected: true },
    ]) {
      expect(() => parseHostUpdateConfig(input)).toThrow();
    }
  });

  it("rejects non-string optional values and credential-only HTTPS URLs", () => {
    const valid = {
      enabled: true,
      manifestUrl: "https://updates.example.test/manifest.json",
      publicKey: "key",
    };
    expect(() => parseHostUpdateConfig({ ...valid, pollMs: "1000" })).toThrow(
      "updateConfig.pollMs must be an integer",
    );
    expect(() =>
      parseHostUpdateConfig({
        ...valid,
        manifestUrl: "https://:secret@updates.example.test/manifest.json",
      }),
    ).toThrow("without credentials");
  });
});
