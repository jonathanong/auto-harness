import { describe, expect, it } from "vitest";

import { configuredArchiveWriter, S3ArchiveWriter } from "./archive-writer.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("S3ArchiveWriter", () => {
  it("uploads only the bounded private session archive contract", async () => {
    const commands: unknown[] = [];
    const writer = new S3ArchiveWriter(
      {
        send: async (command) => {
          commands.push(command);
          return { VersionId: "archive-v1" };
        },
      },
      "private-archives",
    );
    await expect(
      writer.putArchive({
        key: "sessions/session-1/logs.jsonl.gz",
        body: '{"timestamp":"2026-01-01T00:00:00.000Z","stream":"stdout","content":"ok"}\n',
        contentType: "application/x-ndjson",
      }),
    ).resolves.toEqual({
      versionId: "archive-v1",
      contentType: "application/gzip",
      bodyBytes: expect.any(Number),
    });
    expect(commands).toHaveLength(1);
    expect((commands[0] as { input: Record<string, unknown> }).input).toEqual({
      Body: expect.any(Uint8Array),
      Bucket: "private-archives",
      ContentEncoding: "gzip",
      ContentType: "application/gzip",
      Key: "sessions/session-1/logs.jsonl.gz",
      ServerSideEncryption: "AES256",
    });
  });

  it("rejects keys outside the archive prefix and stays disabled without a bucket", async () => {
    const writer = new S3ArchiveWriter({ send: async () => undefined }, "private-archives");
    await expect(
      writer.putArchive({ key: "other/logs.jsonl.gz", body: "", contentType: "text/plain" }),
    ).rejects.toThrow("unexpected archive key");
    await expect(
      writer.putArchive({
        key: "sessions/nested/session/logs.jsonl.gz",
        body: "",
        contentType: "application/x-ndjson",
      }),
    ).rejects.toThrow("unexpected archive key");
    expect(configuredArchiveWriter("", { send: async () => undefined })).toBeUndefined();
    expect(configuredArchiveWriter("private-archives")).toBeInstanceOf(S3ArchiveWriter);
    expect(
      configuredArchiveWriter("private-archives", { send: async () => undefined }),
    ).toBeInstanceOf(S3ArchiveWriter);
  });

  it("rejects an upload response without an immutable version", async () => {
    const writer = new S3ArchiveWriter({ send: async () => ({}) }, "private-archives");
    await expect(
      writer.putArchive({
        key: "sessions/session/logs.jsonl.gz",
        body: "",
        contentType: "text/plain",
      }),
    ).rejects.toThrow("did not return a version id");
  });

  it("pages ListObjectsV2 until the prefix is exhausted", async () => {
    const tokens: Array<string | undefined> = [];
    const writer = new S3ArchiveWriter(
      {
        send: async (command) => {
          const input = (command as { input?: { ContinuationToken?: string } }).input;
          tokens.push(input?.ContinuationToken);
          if (!input?.ContinuationToken) {
            return {
              Contents: [{ Key: "sessions/s/parts/1-1.jsonl.gz" }],
              IsTruncated: true,
              NextContinuationToken: "page-2",
            };
          }
          return {
            Contents: [{ Key: "sessions/s/parts/2-2.jsonl.gz" }],
            IsTruncated: false,
          };
        },
      },
      "private-archives",
    );
    await expect(writer.listKeys("sessions/s/")).resolves.toEqual([
      "sessions/s/parts/1-1.jsonl.gz",
      "sessions/s/parts/2-2.jsonl.gz",
    ]);
    expect(tokens).toEqual([undefined, "page-2"]);
  });

  it("puts and gets gzip session log objects", async () => {
    const stored = new Map<string, Buffer>();
    const writer = new S3ArchiveWriter(
      {
        send: async (command) => {
          const input = (command as { input?: { Key?: string; Body?: Buffer } }).input;
          if (input?.Body && input.Key) {
            stored.set(input.Key, Buffer.from(input.Body));
            return { VersionId: "part-v1" };
          }
          const key = input?.Key ?? "";
          const body = stored.get(key);
          return {
            Body: body ? { transformToByteArray: async () => new Uint8Array(body) } : undefined,
          };
        },
      },
      "private-archives",
    );
    const gzipped = Buffer.from("gzip-bytes");
    await expect(writer.putGzipObject("sessions/s/parts/1-1.jsonl.gz", gzipped)).resolves.toEqual({
      versionId: "part-v1",
      contentType: "application/gzip",
      bodyBytes: gzipped.length,
    });
    await expect(writer.getGzipObject("sessions/s/parts/1-1.jsonl.gz")).resolves.toEqual(gzipped);
    await expect(
      writer.getGzipObject("sessions/s/parts/missing.jsonl.gz"),
    ).resolves.toBeUndefined();
    await expect(writer.putGzipObject("other/key.jsonl.gz", gzipped)).rejects.toThrow(
      "unexpected archive key",
    );
    const noVersion = new S3ArchiveWriter({ send: async () => ({}) }, "private-archives");
    await expect(noVersion.putGzipObject("sessions/s/parts/1-1.jsonl.gz", gzipped)).rejects.toThrow(
      "did not return a version id",
    );
  });

  it("rejects a custom prefix when an object writer is configured", () => {
    expect(() =>
      createControlPlaneState({
        archivePrefix: "custom/",
        archiveWriter: { putArchive: async () => undefined },
      }),
    ).toThrow("Archive object storage requires the sessions/ key prefix");
  });
});
