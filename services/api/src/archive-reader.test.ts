import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { configuredArchiveReader, S3ArchiveReader } from "./archive-reader.ts";

const now = "2026-01-01T00:00:00.000Z";

function reader(
  head: {
    ContentLength?: number;
    ContentType?: string;
    StorageClass?: string;
    Restore?: string;
    ArchiveStatus?: string;
  } = { ContentLength: 12, ContentType: "application/x-ndjson" },
) {
  const send = vi.fn(async () => head);
  const sign = vi.fn(async () => "https://archive.example.test/signed");
  return {
    send,
    sign,
    reader: new S3ArchiveReader({ send }, "archive-bucket", sign),
  };
}

describe("S3ArchiveReader", () => {
  it("heads the canonical object and signs a five-minute attachment download", async () => {
    const fixture = reader();
    await expect(
      fixture.reader.createDownload({
        key: "sessions/session-1/logs.jsonl",
        contentType: "application/x-ndjson",
        bodyBytes: 12,
        now,
      }),
    ).resolves.toEqual({
      available: true,
      downloadUrl: "https://archive.example.test/signed",
      expiresAt: "2026-01-01T00:05:00.000Z",
    });
    expect(fixture.send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect(fixture.send.mock.calls[0]![0].input).toEqual({
      Bucket: "archive-bucket",
      Key: "sessions/session-1/logs.jsonl",
    });
    expect(fixture.sign.mock.calls[0]![1]).toBeInstanceOf(GetObjectCommand);
    expect(fixture.sign.mock.calls[0]![1].input).toEqual({
      Bucket: "archive-bucket",
      Key: "sessions/session-1/logs.jsonl",
      ResponseContentDisposition: 'attachment; filename="session-logs.jsonl"',
      ResponseContentType: "application/x-ndjson",
    });
    expect(fixture.sign.mock.calls[0]![2]).toEqual({
      expiresIn: 300,
      signingDate: new Date(now),
    });
  });

  it("allows a verified empty archive", async () => {
    const fixture = reader({ ContentLength: 0, ContentType: "application/x-ndjson" });
    await expect(
      fixture.reader.createDownload({
        key: "sessions/empty/logs.jsonl",
        contentType: "application/x-ndjson",
        bodyBytes: 0,
        now,
      }),
    ).resolves.toMatchObject({ available: true });
  });

  it.each([
    ["non-canonical key", { key: "sessions/session-1/alternate.jsonl" }],
    ["length mismatch", { bodyBytes: 13 }],
    ["content type mismatch", { contentType: "text/plain" }],
    ["invalid clock", { now: "invalid" }],
  ])("marks %s unavailable", async (_name, override) => {
    const fixture = reader();
    await expect(
      fixture.reader.createDownload({
        key: "sessions/session-1/logs.jsonl",
        contentType: "application/x-ndjson",
        bodyBytes: 12,
        now,
        ...override,
      }),
    ).resolves.toEqual({ available: false });
  });

  it.each([
    { StorageClass: "GLACIER" },
    { StorageClass: "DEEP_ARCHIVE", Restore: 'ongoing-request="true"' },
    { ArchiveStatus: "ARCHIVE_ACCESS" },
  ])("does not sign cold archive storage: %o", async (cold) => {
    const fixture = reader({
      ContentLength: 12,
      ContentType: "application/x-ndjson",
      ...cold,
    });
    await expect(
      fixture.reader.createDownload({
        key: "sessions/session-1/logs.jsonl",
        contentType: "application/x-ndjson",
        bodyBytes: 12,
        now,
      }),
    ).resolves.toEqual({ available: false });
    expect(fixture.sign).not.toHaveBeenCalled();
  });

  it("allows a restored Glacier object", async () => {
    const fixture = reader({
      ContentLength: 12,
      ContentType: "application/x-ndjson",
      StorageClass: "GLACIER",
      Restore: 'ongoing-request="false", expiry-date="Fri, 02 Jan 2026 00:00:00 GMT"',
    });
    await expect(
      fixture.reader.createDownload({
        key: "sessions/session-1/logs.jsonl",
        contentType: "application/x-ndjson",
        bodyBytes: 12,
        now,
      }),
    ).resolves.toMatchObject({ available: true });
  });

  it("contains missing, denied, and signer failures as unavailable", async () => {
    const missing = new S3ArchiveReader(
      { send: async () => Promise.reject(new Error("missing")) },
      "bucket",
    );
    await expect(
      missing.createDownload({
        key: "sessions/session-1/logs.jsonl",
        contentType: "application/x-ndjson",
        bodyBytes: 12,
        now,
      }),
    ).resolves.toEqual({ available: false });

    const denied = reader();
    denied.sign.mockRejectedValueOnce(new Error("denied"));
    await expect(
      denied.reader.createDownload({
        key: "sessions/session-1/logs.jsonl",
        contentType: "application/x-ndjson",
        bodyBytes: 12,
        now,
      }),
    ).resolves.toEqual({ available: false });
  });

  it("configures only when a bucket is present", () => {
    expect(configuredArchiveReader("")).toBeUndefined();
    expect(configuredArchiveReader("bucket", { send: async () => ({}) })).toBeInstanceOf(
      S3ArchiveReader,
    );
  });
});
