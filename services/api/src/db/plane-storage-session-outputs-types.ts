export type SessionOutputManifest = {
  sessionId: string;
  recordKey: "manifest";
  attemptId: string;
  capturedAt: string;
  fingerprint: string;
  outputState: "none" | "error" | "ready";
  outputError?: { code: string; message: string };
  artifactsState: "none" | "error" | "pending" | "ready";
  artifactsError?: { code: string; message: string };
  compressedBytes?: number;
  sourceBytes?: number;
  fileCount?: number;
  sha256?: string;
  objectKey?: string;
  objectVersionId?: string;
  preparedAt: string;
  completedAt?: string;
};

export type SessionOutputPayload = {
  sessionId: string;
  recordKey: "payload";
  attemptId: string;
  jsonText: string;
  sha256: string;
};
