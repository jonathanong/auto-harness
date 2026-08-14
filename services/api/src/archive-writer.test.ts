import { describe, expect, it } from "vitest";

import { configuredArchiveWriter, S3ArchiveWriter } from "./archive-writer.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("S3ArchiveWriter", () => {
  it("uploads only the bounded private session archive contract", async () => {
    const commands: unknown[] = [];
    const writer = new S3ArchiveWriter(
      { send: async (command) => commands.push(command) },
      "private-archives",
    );
    await writer.putArchive({
      key: "sessions/session-1/logs.jsonl",
      body: '{"timestamp":"2026-01-01T00:00:00.000Z","stream":"stdout","content":"ok"}\n',
      contentType: "application/x-ndjson",
    });
    expect(commands).toHaveLength(1);
    expect((commands[0] as { input: Record<string, unknown> }).input).toEqual({
      Body: expect.any(String),
      Bucket: "private-archives",
      ContentType: "application/x-ndjson",
      Key: "sessions/session-1/logs.jsonl",
      ServerSideEncryption: "AES256",
    });
  });

  it("rejects keys outside the archive prefix and stays disabled without a bucket", async () => {
    const writer = new S3ArchiveWriter({ send: async () => undefined }, "private-archives");
    await expect(
      writer.putArchive({ key: "other/logs.jsonl", body: "", contentType: "text/plain" }),
    ).rejects.toThrow("unexpected archive key");
    await expect(
      writer.putArchive({
        key: "sessions/nested/session/logs.jsonl",
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

  it("rejects a custom prefix when an object writer is configured", () => {
    expect(() =>
      createControlPlaneState({
        archivePrefix: "custom/",
        archiveWriter: { putArchive: async () => undefined },
      }),
    ).toThrow("Archive writers require the sessions/ key prefix");
  });
});
