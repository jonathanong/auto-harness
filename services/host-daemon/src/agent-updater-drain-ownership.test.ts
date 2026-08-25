import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AgentUpdater, canonicalManifest } from "./agent-updater.ts";

const artifact = Buffer.from("synthetic agent artifact");
const digest = createHash("sha256").update(artifact).digest("hex");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const manifest = () => {
  const unsigned = {
    version: "1.2.0",
    artifactUrl: "https://updates.example.test/agent-1.2.0.tgz",
    sha256: digest,
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalManifest(unsigned)), keys.privateKey).toString(
      "base64url",
    ),
  };
};

describe("AgentUpdater drain ownership", () => {
  it("defers a newer release without replacing an operator-owned drain", async () => {
    const calls: string[] = [];
    const updater = new AgentUpdater({
      currentVersion: "1.0.0",
      manifestPublicKey: publicKey,
      fetcher: {
        fetchManifest: async () => manifest(),
        fetchArtifact: async () => {
          calls.push("download");
          return artifact;
        },
      },
      lifecycle: {
        drain: async () => {
          calls.push("drain");
          return false;
        },
        waitForIdle: async () => {
          calls.push("idle");
        },
        resume: async () => {
          calls.push("resume");
        },
      },
      installer: {
        stage: async () => void calls.push("stage"),
        activate: async () => void calls.push("activate"),
        restart: async () => void calls.push("restart"),
        rollback: async () => void calls.push("rollback"),
      },
    });

    await expect(updater.run()).resolves.toEqual({
      phase: "deferred",
      currentVersion: "1.0.0",
      targetVersion: "1.2.0",
    });
    expect(calls).toEqual(["drain"]);
  });

  it("does not resume a drain that was already owned by an operator", async () => {
    let resumed = false;
    const updater = new AgentUpdater({
      currentVersion: "1.0.0",
      manifestPublicKey: publicKey,
      fetcher: {
        fetchManifest: async () => manifest(),
        fetchArtifact: async () => Buffer.from("tampered"),
      },
      lifecycle: {
        drain: async () => false,
        waitForIdle: async () => undefined,
        resume: async () => {
          resumed = true;
        },
      },
      installer: {
        stage: async () => undefined,
        activate: async () => undefined,
        restart: async () => undefined,
        rollback: async () => undefined,
      },
    });
    await expect(updater.run()).resolves.toMatchObject({ phase: "deferred" });
    expect(resumed).toBe(false);
  });
});
