import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DOWNLOAD_EXPIRES_SECONDS = 5 * 60;
const ARCHIVE_CONTENT_DISPOSITION = 'attachment; filename="session-logs.jsonl"';

type ArchiveS3Client = {
  send(command: HeadObjectCommand): Promise<{
    ContentLength?: number;
    ContentType?: string;
    StorageClass?: string;
    Restore?: string;
    ArchiveStatus?: string;
  }>;
};

type ArchiveSigner = (
  client: ArchiveS3Client,
  command: GetObjectCommand,
  options: { expiresIn: number; signingDate: Date },
) => Promise<string>;

export type ArchiveReaderResult =
  | { available: true; downloadUrl: string; expiresAt: string }
  | { available: false };

export type ArchiveReader = {
  createDownload(input: {
    key: string;
    contentType: string;
    bodyBytes: number;
    now: string;
  }): Promise<ArchiveReaderResult>;
};

function isRestored(storageClass: string | undefined, restore: string | undefined): boolean {
  if (storageClass !== "GLACIER" && storageClass !== "DEEP_ARCHIVE") return true;
  return restore?.includes('ongoing-request="false"') === true;
}

export class S3ArchiveReader implements ArchiveReader {
  private readonly client: ArchiveS3Client;
  private readonly bucket: string;
  private readonly signer: ArchiveSigner;

  constructor(
    client: ArchiveS3Client,
    bucket: string,
    signer: ArchiveSigner = (archiveClient, command, options) =>
      getSignedUrl(archiveClient as S3Client, command, options),
  ) {
    this.client = client;
    this.bucket = bucket;
    this.signer = signer;
  }

  async createDownload(input: {
    key: string;
    contentType: string;
    bodyBytes: number;
    now: string;
  }): Promise<ArchiveReaderResult> {
    if (!/^sessions\/[^/]+\/logs\.jsonl$/.test(input.key)) return { available: false };
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: input.key }),
      );
      if (
        head.ContentLength !== input.bodyBytes ||
        head.ContentType !== input.contentType ||
        head.ArchiveStatus !== undefined ||
        !isRestored(head.StorageClass, head.Restore)
      ) {
        return { available: false };
      }
      const signingDate = new Date(input.now);
      if (Number.isNaN(signingDate.valueOf())) return { available: false };
      const downloadUrl = await this.signer(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          ResponseContentDisposition: ARCHIVE_CONTENT_DISPOSITION,
          ResponseContentType: input.contentType,
        }),
        { expiresIn: DOWNLOAD_EXPIRES_SECONDS, signingDate },
      );
      return {
        available: true,
        downloadUrl,
        expiresAt: new Date(signingDate.valueOf() + DOWNLOAD_EXPIRES_SECONDS * 1000).toISOString(),
      };
    } catch {
      return { available: false };
    }
  }
}

export function configuredArchiveReader(
  bucket = process.env.ARCHIVE_BUCKET,
  client?: ArchiveS3Client,
): ArchiveReader | undefined {
  return bucket ? new S3ArchiveReader(client ?? new S3Client({}), bucket) : undefined;
}
