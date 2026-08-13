import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AgentUpdater, canonicalManifest, parseAndVerifyManifest } from "./agent-updater.ts";

const artifact = Buffer.from("synthetic agent artifact");
const digest = createHash("sha256").update(artifact).digest("hex");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function manifest(version = "1.2.0") {
  const unsigned = {
    version,
    artifactUrl: "https://updates.example.test/agent-1.2.0.tgz",
    sha256: digest,
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalManifest(unsigned)), keys.privateKey).toString(
      "base64url",
    ),
  };
}

describe("AgentUpdater", () => {
  it("drains, waits, verifies, stages, activates, and requests restart in order", async () => {
    const calls: string[] = [];
    const states: string[] = [];
    const updater = new AgentUpdater({
      currentVersion: "1.1.9",
      manifestPublicKey: publicKey,
      fetcher: {
        fetchManifest: async () => manifest(),
        fetchArtifact: async (url) => {
          calls.push(`download:${url}`);
          return artifact;
        },
      },
      lifecycle: {
        drain: async () => void calls.push("drain"),
        waitForIdle: async () => void calls.push("idle"),
        resume: async () => void calls.push("resume"),
      },
      installer: {
        stage: async ({ version }) => void calls.push(`stage:${version}`),
        activate: async (version) => void calls.push(`activate:${version}`),
        restart: async () => void calls.push("restart"),
      },
      onState: (state) => states.push(state.phase),
    });
    const [first, duplicate] = await Promise.all([updater.run(), updater.run()]);
    expect(first).toEqual({ phase: "complete", currentVersion: "1.2.0" });
    expect(duplicate).toEqual(first);
    expect(calls).toEqual([
      "drain",
      "idle",
      "download:https://updates.example.test/agent-1.2.0.tgz",
      "stage:1.2.0",
      "activate:1.2.0",
      "restart",
    ]);
    expect(states).toEqual(["draining", "downloading", "staged", "restarting", "complete"]);
    await expect(updater.run()).resolves.toEqual(first);
    expect(calls).toHaveLength(6);
  });

  it("does not drain for an equal or older signed version", async () => {
    let drained = false;
    const updater = new AgentUpdater({
      currentVersion: "2.0.0",
      manifestPublicKey: publicKey,
      fetcher: {
        fetchManifest: async () => manifest("1.9.9"),
        fetchArtifact: async () => artifact,
      },
      lifecycle: {
        drain: async () => void (drained = true),
        waitForIdle: async () => undefined,
        resume: async () => undefined,
      },
      installer: {
        stage: async () => undefined,
        activate: async () => undefined,
        restart: async () => undefined,
      },
    });
    await expect(updater.run()).resolves.toEqual({ phase: "complete", currentVersion: "2.0.0" });
    expect(drained).toBe(false);

    const equalUpdater = new AgentUpdater({
      currentVersion: "2.0.0",
      manifestPublicKey: publicKey,
      fetcher: {
        fetchManifest: async () => manifest("2.0.0"),
        fetchArtifact: async () => artifact,
      },
      lifecycle: {
        drain: async () => undefined,
        waitForIdle: async () => undefined,
        resume: async () => undefined,
      },
      installer: {
        stage: async () => undefined,
        activate: async () => undefined,
        restart: async () => undefined,
      },
    });
    await expect(equalUpdater.run()).resolves.toEqual({
      phase: "complete",
      currentVersion: "2.0.0",
    });

    const largeVersionUpdater = new AgentUpdater({
      currentVersion: "9007199254740992.0.0",
      manifestPublicKey: publicKey,
      fetcher: {
        fetchManifest: async () => manifest("9007199254740993.0.0"),
        fetchArtifact: async () => artifact,
      },
      lifecycle: {
        drain: async () => undefined,
        waitForIdle: async () => undefined,
        resume: async () => undefined,
      },
      installer: {
        stage: async () => undefined,
        activate: async () => undefined,
        restart: async () => undefined,
      },
    });
    await expect(largeVersionUpdater.run()).resolves.toEqual({
      phase: "complete",
      currentVersion: "9007199254740993.0.0",
    });
  });

  it("fails closed before install for invalid manifests, signatures, and artifacts", async () => {
    expect(() => parseAndVerifyManifest({}, publicKey)).toThrow("invalid update manifest");
    expect(() => parseAndVerifyManifest({ ...manifest(), signature: "bad" }, publicKey)).toThrow(
      "invalid update manifest signature",
    );
    const updater = new AgentUpdater({
      currentVersion: "1.0.0",
      manifestPublicKey: publicKey,
      fetcher: {
        fetchManifest: async () => manifest(),
        fetchArtifact: async () => Buffer.from("tampered"),
      },
      lifecycle: {
        drain: async () => undefined,
        waitForIdle: async () => undefined,
        resume: async () => undefined,
      },
      installer: {
        stage: async () => {
          throw new Error("must not stage");
        },
        activate: async () => undefined,
        restart: async () => undefined,
      },
    });
    await expect(updater.run()).resolves.toMatchObject({
      phase: "failed",
      targetVersion: "1.2.0",
      error: "artifact checksum mismatch",
    });
    expect(updater.getState().phase).toBe("failed");
  });

  it("rejects every malformed manifest field", () => {
    const valid = manifest();
    const invalid = [
      null,
      "manifest",
      { ...valid, version: 1 },
      { ...valid, version: "1.2" },
      { ...valid, artifactUrl: 1 },
      { ...valid, artifactUrl: "http://updates.example.test/agent.tgz" },
      { ...valid, sha256: 1 },
      { ...valid, sha256: "abc" },
      { ...valid, signature: 1 },
      { ...valid, signature: "" },
    ];
    for (const candidate of invalid) {
      expect(() => parseAndVerifyManifest(candidate, publicKey)).toThrow("invalid update manifest");
    }
  });
});
