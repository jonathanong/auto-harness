import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type ArchiveWriter = {
  putArchive(object: { key: string; body: string; contentType: string }): Promise<void>;
};

type ArchiveS3Client = {
  send(command: PutObjectCommand): Promise<unknown>;
};

export class S3ArchiveWriter implements ArchiveWriter {
  private readonly client: ArchiveS3Client;
  private readonly bucket: string;

  constructor(client: ArchiveS3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async putArchive(object: { key: string; body: string; contentType: string }): Promise<void> {
    if (!object.key.startsWith("sessions/") || !object.key.endsWith("/logs.jsonl")) {
      throw new Error(`Refusing unexpected archive key: ${object.key}`);
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: object.key,
        Body: object.body,
        ContentType: object.contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }
}

export function configuredArchiveWriter(
  bucket = process.env.ARCHIVE_BUCKET,
  client?: ArchiveS3Client,
): ArchiveWriter | undefined {
  return bucket ? new S3ArchiveWriter(client ?? new S3Client({}), bucket) : undefined;
}
