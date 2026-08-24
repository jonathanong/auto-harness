import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { expect, it } from "vitest";

import { AgentUpdater, canonicalManifest } from "./agent-updater.ts";

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

it("appends rollback and resume failures after a failed activation", async () => {
  const updater = new AgentUpdater({
    currentVersion: "1.0.0",
    manifestPublicKey: publicKey,
    fetcher: {
      fetchManifest: async () => manifest,
      fetchArtifact: async () => artifact,
    },
    lifecycle: {
      drain: async () => undefined,
      waitForIdle: async () => undefined,
      resume: async () => {
        throw new Error("resume down");
      },
    },
    installer: {
      stage: async () => undefined,
      activate: async () => {
        throw new Error("activate down");
      },
      restart: async () => undefined,
      rollback: async () => {
        throw new Error("rollback down");
      },
    },
  });
  await expect(updater.run()).resolves.toMatchObject({
    phase: "failed",
    error: "activate down; rollback failed: rollback down; resume failed: resume down",
  });
});
