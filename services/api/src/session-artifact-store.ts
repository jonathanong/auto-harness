import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS,
  type SessionArtifactUpload,
} from "@auto-harness/shared";
import { sessionArtifactKey } from "./session-artifact-key.ts";

export const CONTENT_TYPE = "application/gzip";
export const DOWNLOAD_TTL_SECONDS = 300;

export type ArtifactObject = {
  versionId: string;
  size: number;
  sha256: string;
  contentType: string;
};

export interface SessionArtifactStore {
  upload(
    sessionId: string,
    attemptId: string,
    size: number,
    sha256: string,
    now: string,
    baseUrl: string,
    authorization?: string,
  ): Promise<SessionArtifactUpload>;
  inspect(sessionId: string, attemptId: string): Promise<ArtifactObject | null>;
  downloadUrl(
    sessionId: string,
    attemptId: string,
    versionId: string,
    baseUrl: string,
    nowMs: number,
  ): Promise<string>;
  deleteSession?(sessionId: string, attemptId: string): Promise<void>;
}

export class S3SessionArtifactStore implements SessionArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(client: S3Client, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async upload(
    sessionId: string,
    attemptId: string,
    size: number,
    sha256: string,
  ): Promise<SessionArtifactUpload> {
    const issuedAt = Date.now();
    const encoded = Buffer.from(sha256, "hex").toString("base64");
    const key = sessionArtifactKey(sessionId, attemptId);
    const fields = {
      "Content-Type": CONTENT_TYPE,
      "x-amz-checksum-sha256": encoded,
      "x-amz-server-side-encryption": "AES256",
    };
    const signed = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Fields: fields,
      Conditions: [
        ["content-length-range", size, size],
        { "Content-Type": CONTENT_TYPE },
        { "x-amz-checksum-sha256": encoded },
        { "x-amz-server-side-encryption": "AES256" },
      ],
      Expires: SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS,
    });
    return {
      method: "POST",
      url: signed.url,
      fields: signed.fields,
      expiresAt: new Date(issuedAt + SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async inspect(sessionId: string, attemptId: string): Promise<ArtifactObject | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: sessionArtifactKey(sessionId, attemptId),
          ChecksumMode: "ENABLED",
        }),
      );
      if (!result.VersionId || !result.ContentLength || !result.ChecksumSHA256) return null;
      return {
        versionId: result.VersionId,
        size: result.ContentLength,
        sha256: Buffer.from(result.ChecksumSHA256, "base64").toString("hex"),
        contentType: result.ContentType ?? "",
      };
    } catch (error) {
      if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey"))
        return null;
      throw error;
    }
  }

  downloadUrl(
    sessionId: string,
    attemptId: string,
    versionId: string,
    _baseUrl: string,
    nowMs: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: sessionArtifactKey(sessionId, attemptId),
        VersionId: versionId,
        ResponseContentDisposition: 'attachment; filename="artifacts.tar.gz"',
      }),
      { expiresIn: DOWNLOAD_TTL_SECONDS, signingDate: new Date(nowMs) },
    );
  }
}

export { LocalSessionArtifactStore } from "./session-artifact-store-local.ts";
