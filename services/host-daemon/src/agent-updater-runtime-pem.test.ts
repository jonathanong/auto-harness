import { generateKeyPairSync, sign } from "node:crypto";

import { parseHostUpdateConfig } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { canonicalManifest } from "./agent-updater.ts";
import { createDaemonUpdater, withHostUpdateConfig } from "./agent-updater-runtime.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { baseOpts, seededFs } from "./host-service-test-helpers.ts";

describe("daemon updater PEM configuration", () => {
  it("decodes a persisted single-line PEM before verifying its signed manifest", async () => {
    const keys = generateKeyPairSync("ed25519");
    const config = parseHostUpdateConfig({
      enabled: true,
      manifestUrl: "https://updates.example.test/manifest.json",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      daemonVersion: "1.0.0",
    });
    expect(config.publicKey).toContain("\\n");
    expect(config.publicKey).not.toContain("\n");
    const unsigned = {
      version: "1.0.0",
      artifactUrl: "https://updates.example.test/agent-1.0.0.tgz",
      sha256: "0".repeat(64),
    };
    const manifest = {
      ...unsigned,
      signature: sign(null, Buffer.from(canonicalManifest(unsigned)), keys.privateKey).toString(
        "base64url",
      ),
    };
    const updater = createDaemonUpdater({
      loop: {} as DaemonLoop,
      env: withHostUpdateConfig({}, config),
      log: () => undefined,
      error: () => undefined,
      service: baseOpts({ platform: "darwin", fs: seededFs() }),
      fetchFn: async () => ({ ok: true, status: 200, json: async () => manifest }),
    });
    await expect(updater!.run()).resolves.toEqual({ phase: "complete", currentVersion: "1.0.0" });
  });
});
