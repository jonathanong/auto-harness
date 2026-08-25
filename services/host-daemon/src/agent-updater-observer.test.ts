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

it("keeps observer failures from interrupting activation and restart", async () => {
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
      resume: async () => void calls.push("resume"),
    },
    installer: {
      stage: async () => void calls.push("stage"),
      activate: async () => void calls.push("activate"),
      restart: async () => void calls.push("restart"),
      rollback: async () => void calls.push("rollback"),
    },
    onState: () => {
      throw new Error("observer unavailable");
    },
  });

  await expect(updater.run()).resolves.toEqual({
    phase: "restarting",
    currentVersion: "1.0.0",
    targetVersion: "1.2.0",
  });
  expect(calls).toEqual(["drain", "idle", "stage", "activate", "restart"]);
});

function failingUpdater(
  fetchArtifact: () => Promise<Uint8Array>,
  activate: () => Promise<void> = async () => undefined,
  resume: () => Promise<void> = async () => undefined,
) {
  const calls: string[] = [];
  return {
    calls,
    updater: new AgentUpdater({
      currentVersion: "1.0.0",
      manifestPublicKey: publicKey,
      fetcher: { fetchManifest: async () => manifest, fetchArtifact },
      lifecycle: {
        drain: async () => void calls.push("drain"),
        waitForIdle: async () => void calls.push("idle"),
        resume: async () => {
          calls.push("resume");
          await resume();
        },
      },
      installer: {
        stage: async () => void calls.push("stage"),
        activate: async () => {
          calls.push("activate");
          await activate();
        },
        restart: async () => void calls.push("restart"),
        rollback: async () => void calls.push("rollback"),
      },
    }),
  };
}

it("resumes work acceptance after download and checksum failures", async () => {
  const download = failingUpdater(async () => {
    throw new Error("download failed");
  });
  await expect(download.updater.run()).resolves.toMatchObject({ error: "download failed" });
  expect(download.calls).toEqual(["drain", "idle", "resume"]);

  const checksum = failingUpdater(async () => Buffer.from("tampered"));
  await expect(checksum.updater.run()).resolves.toMatchObject({
    error: "artifact checksum mismatch",
  });
  expect(checksum.calls).toEqual(["drain", "idle", "resume"]);
});

it("resumes without rollback when activation fails before current switches", async () => {
  const resumeFailure = failingUpdater(
    async () => Promise.reject("download offline"),
    undefined,
    async () => Promise.reject("resume offline"),
  );
  await expect(resumeFailure.updater.run()).resolves.toMatchObject({
    error: "download offline; resume failed: resume offline",
  });
  const resumeError = failingUpdater(
    async () => Promise.reject("download offline"),
    undefined,
    async () => Promise.reject(new Error("resume error")),
  );
  await expect(resumeError.updater.run()).resolves.toMatchObject({
    error: "download offline; resume failed: resume error",
  });
  const activationFailure = failingUpdater(
    async () => artifact,
    async () => {
      throw new Error("activation failed");
    },
  );
  await expect(activationFailure.updater.run()).resolves.toMatchObject({
    error: "activation failed",
  });
  expect(activationFailure.calls).toEqual(["drain", "idle", "stage", "activate", "resume"]);
});

it("reports manifest fetch failures without attempting lifecycle recovery", async () => {
  const updater = new AgentUpdater({
    currentVersion: "1.0.0",
    manifestPublicKey: publicKey,
    fetcher: {
      fetchManifest: async () => Promise.reject("offline"),
      fetchArtifact: async () => artifact,
    },
    lifecycle: {
      drain: async () => undefined,
      waitForIdle: async () => undefined,
      resume: async () => {
        throw new Error("must not resume");
      },
    },
    installer: {
      stage: async () => undefined,
      activate: async () => undefined,
      restart: async () => undefined,
      rollback: async () => undefined,
    },
  });
  await expect(updater.run()).resolves.toEqual({
    phase: "failed",
    currentVersion: "1.0.0",
    error: "offline",
  });
});
