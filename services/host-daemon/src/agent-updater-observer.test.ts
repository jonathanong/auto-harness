import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { expect, it } from "vitest";

import { AgentUpdater, canonicalManifest } from "./agent-updater.ts";

it("keeps observer failures from interrupting activation and restart", async () => {
  const artifact = Buffer.from("synthetic agent artifact");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const unsigned = {
    version: "1.2.0",
    artifactUrl: "https://updates.example.test/agent-1.2.0.tgz",
    sha256: createHash("sha256").update(artifact).digest("hex"),
  };
  const manifest = {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalManifest(unsigned)), keys.privateKey).toString(
      "base64url",
    ),
  };
  const calls: string[] = [];
  const updater = new AgentUpdater({
    currentVersion: "1.0.0",
    manifestPublicKey: publicKey,
    fetcher: {
      fetchManifest: async () => manifest,
      fetchArtifact: async () => artifact,
    },
    lifecycle: {
      drain: async () => void calls.push("drain"),
      waitForIdle: async () => void calls.push("idle"),
    },
    installer: {
      stage: async () => void calls.push("stage"),
      activate: async () => void calls.push("activate"),
      restart: async () => void calls.push("restart"),
    },
    onState: () => {
      throw new Error("observer unavailable");
    },
  });

  await expect(updater.run()).resolves.toEqual({
    phase: "complete",
    currentVersion: "1.2.0",
  });
  expect(calls).toEqual(["drain", "idle", "stage", "activate", "restart"]);
});
