import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { LocalSessionArtifactStore, S3SessionArtifactStore } from "./session-artifact-store.ts";
import { sessionArtifactKey } from "./session-artifact-key.ts";

describe("session artifact object boundaries", () => {
  it("signs an exact S3 key, checksum, type, encryption and bounded POST policy", async () => {
    const digest = createHash("sha256").update("payload").digest("hex");
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "x-amz-version-id": "v1",
        "content-length": "7",
        "content-type": "application/gzip",
        "x-amz-checksum-sha256": Buffer.from(digest, "hex").toString("base64"),
      });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const client = new S3Client({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "secret" },
    });
    const store = new S3SessionArtifactStore(client, "bucket");
    const upload = await store.upload(
      "sess-one",
      "attempt-one",
      7,
      digest,
      new Date().toISOString(),
      "unused",
    );
    expect(upload.method).toBe("POST");
    if (upload.method !== "POST") throw new Error("expected POST");
    expect(upload.fields.key).toBe(sessionArtifactKey("sess-one", "attempt-one"));
    const policy = JSON.parse(Buffer.from(upload.fields.Policy!, "base64").toString("utf8")) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual({ "Content-Type": "application/gzip" });
    expect(policy.conditions).toContainEqual({ "x-amz-server-side-encryption": "AES256" });
    expect(policy.conditions).toContainEqual({
      "x-amz-checksum-sha256": Buffer.from(digest, "hex").toString("base64"),
    });
    expect(policy.conditions).toContainEqual(["content-length-range", 7, 7]);
    expect(await store.inspect("sess-one", "attempt-one")).toMatchObject({
      versionId: "v1",
      size: 7,
      sha256: digest,
    });
    const url = await store.downloadUrl("sess-one", "attempt-one", "v1", "unused", Date.now());
    expect(url).toContain("versionId=v1");
    await client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps local upload bytes on disk and fences signed URLs and tampered content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-artifact-test-"));
    const store = new LocalSessionArtifactStore(dir);
    const bytes = Buffer.from("payload");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await store.upload(
      "sess",
      "attempt",
      bytes.length,
      sha256,
      new Date().toISOString(),
      "http://127.0.0.1:9000",
    );
    expect(upload.method).toBe("PUT");
    if (upload.method !== "PUT") throw new Error("expected PUT");
    const url = new URL(upload.url);
    expect(
      store.verify(
        "sess",
        "attempt",
        sha256,
        url.searchParams.get("expires"),
        url.searchParams.get("token"),
      ),
    ).toBe(true);
    expect(
      store.verify(
        "other",
        "attempt",
        sha256,
        url.searchParams.get("expires"),
        url.searchParams.get("token"),
      ),
    ).toBe(false);
    expect(store.verify("sess", "attempt", sha256, null, null)).toBe(false);
    expect(store.verify("sess", "attempt", sha256, String(Date.now() - 1), "a".repeat(64))).toBe(
      false,
    );
    expect(store.verify("sess", "attempt", sha256, url.searchParams.get("expires"), "bad")).toBe(
      false,
    );
    const authenticated = await store.upload(
      "sess",
      "attempt",
      bytes.length,
      sha256,
      new Date().toISOString(),
      "http://127.0.0.1:9000",
      "Bearer host-key",
    );
    expect(authenticated.method).toBe("PUT");
    if (authenticated.method !== "PUT") throw new Error("expected PUT");
    expect(authenticated.headers.authorization).toBe("Bearer host-key");
    const input = Readable.from([bytes]) as never;
    await store.put(input, "sess", "attempt", { size: bytes.length, sha256 });
    expect(await store.inspect("sess", "attempt")).toMatchObject({
      versionId: sha256,
      size: bytes.length,
    });
    const readUrl = new URL(
      await store.downloadUrl("sess", "attempt", sha256, "http://127.0.0.1:9000", Date.now()),
    );
    expect(
      store.verify(
        "sess",
        "attempt",
        sha256,
        readUrl.searchParams.get("expires"),
        readUrl.searchParams.get("token"),
      ),
    ).toBe(true);
    await store.deleteSession("sess", "attempt");
    expect(await store.inspect("sess", "attempt")).toBeNull();
    await store.deleteSession("sess", "attempt");
  });

  it("distinguishes absent, incomplete, and failed S3 HEAD responses", async () => {
    let status = 404;
    let completeWithoutType = false;
    const digest = createHash("sha256").update("payload").digest("hex");
    const server = createServer((_req, res) => {
      if (status === 200) {
        res.writeHead(
          200,
          completeWithoutType
            ? {
                "x-amz-version-id": "v1",
                "content-length": "7",
                "x-amz-checksum-sha256": Buffer.from(digest, "hex").toString("base64"),
              }
            : { "content-length": "7" },
        );
      } else {
        res.writeHead(status, { "content-type": "application/xml" });
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const client = new S3Client({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: "test", secretAccessKey: "secret" },
    });
    const store = new S3SessionArtifactStore(client, "bucket");
    try {
      expect(await store.inspect("sess", "attempt")).toBeNull();
      status = 200;
      expect(await store.inspect("sess", "attempt")).toBeNull();
      completeWithoutType = true;
      expect(await store.inspect("sess", "attempt")).toMatchObject({
        contentType: "",
        sha256: digest,
      });
      status = 500;
      await expect(store.inspect("sess", "attempt")).rejects.toThrow();
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects unsafe raw session key segments", () => {
    expect(() => sessionArtifactKey("../other", "attempt")).toThrow("invalid session artifact id");
  });
});
