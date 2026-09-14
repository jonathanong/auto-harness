import { gzipSync } from "node:zlib";

import { isSessionLogObjectKey } from "@auto-harness/shared";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type ArchiveWriter = {
  putArchive(object: {
    key: string;
    body: string;
    contentType: string;
  }): Promise<ArchiveWriteResult | void>;
  putGzipObject?(key: string, body: Buffer): Promise<ArchiveWriteResult | void>;
  getGzipObject?(key: string): Promise<Buffer | undefined>;
  listKeys?(prefix: string): Promise<string[]>;
};

export type ArchiveWriteResult = {
  versionId: string;
  contentType?: string;
  bodyBytes?: number;
};

type ArchiveS3Client = {
  send(command: unknown): Promise<unknown>;
};

export class S3ArchiveWriter implements ArchiveWriter {
  private readonly client: ArchiveS3Client;
  private readonly bucket: string;

  constructor(client: ArchiveS3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async putArchive(object: {
    key: string;
    body: string;
    contentType: string;
  }): Promise<ArchiveWriteResult> {
    if (!isSessionLogObjectKey(object.key)) {
      throw new Error(`Refusing unexpected archive key: ${object.key}`);
    }
    const gzipped = gzipSync(object.body);
    const result = (await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: object.key,
        Body: gzipped,
        ContentType: "application/gzip",
        ContentEncoding: "gzip",
        ServerSideEncryption: "AES256",
      }),
    )) as { VersionId?: unknown };
    if (typeof result.VersionId !== "string" || result.VersionId.length === 0) {
      throw new Error("S3 archive upload did not return a version id");
    }
    return {
      versionId: result.VersionId,
      contentType: "application/gzip",
      bodyBytes: gzipped.length,
    };
  }

  async putGzipObject(key: string, body: Buffer): Promise<ArchiveWriteResult> {
    if (!isSessionLogObjectKey(key)) {
      throw new Error(`Refusing unexpected archive key: ${key}`);
    }
    const result = (await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/gzip",
        ContentEncoding: "gzip",
        ServerSideEncryption: "AES256",
      }),
    )) as { VersionId?: unknown };
    if (typeof result.VersionId !== "string" || result.VersionId.length === 0) {
      throw new Error("S3 archive upload did not return a version id");
    }
    return {
      versionId: result.VersionId,
      contentType: "application/gzip",
      bodyBytes: body.length,
    };
  }

  async getGzipObject(key: string): Promise<Buffer | undefined> {
    const result = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } };
    const bytes = await result.Body?.transformToByteArray?.();
    return bytes ? Buffer.from(bytes) : undefined;
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      )) as {
        Contents?: Array<{ Key?: string }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const entry of result.Contents ?? []) {
        if (typeof entry.Key === "string") keys.push(entry.Key);
      }
      continuationToken =
        result.IsTruncated === true && typeof result.NextContinuationToken === "string"
          ? result.NextContinuationToken
          : undefined;
    } while (continuationToken);
    return keys;
  }
}

export function configuredArchiveWriter(
  bucket = process.env.ARCHIVE_BUCKET,
  client?: ArchiveS3Client,
): ArchiveWriter | undefined {
  return bucket ? new S3ArchiveWriter(client ?? new S3Client({}), bucket) : undefined;
}
