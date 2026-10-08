import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  opendir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  lstat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { finished, pipeline } from "node:stream/promises";
import { homedir } from "node:os";
/* eslint-disable max-lines -- durable capture and bounded publication share one spool state machine. */
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pack as createTar } from "tar-stream";
import type {
  PrepareSessionOutputsRequest,
  PrepareSessionOutputsResponse,
  SessionArtifactsSubmission,
  SessionOutputSubmission,
} from "@auto-harness/shared";
import {
  MAX_SESSION_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACT_FILES,
  MAX_SESSION_ARTIFACT_SOURCE_BYTES,
  MAX_SESSION_OUTPUT_BYTES,
  SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS,
  SESSION_OUTPUT_RETRY_WINDOW_MS,
} from "@auto-harness/shared";

import { httpBaseFromApiUrl } from "./bootstrap.ts";

const JOB_LIMIT = 100;
const ERROR_RECORD_LIMIT = 100;
const ERROR_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_LIMIT = 2 * 1024 * 1024 * 1024;
const PASS_LIMIT = 25;
const CONCURRENCY = 2;
const API_TIMEOUT_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const FETCH = globalThis.fetch;

type Identity = { apiUrl: string; apiKey?: string };
type Job = {
  sessionId: string;
  attemptId: string;
  capturedAt: string;
  completedAt: string;
  expiresAt: string;
  output: SessionOutputSubmission;
  artifactSource: string;
  artifact?: Extract<SessionArtifactsSubmission, { state: "pending" }>;
  artifactError?: { code: string; message: string };
  retryAt: number;
  failures: number;
};

export type SessionOutputAttempt = {
  readonly jobId: string;
  readonly env: { HARNESS_OUTPUT_FILE: string; HARNESS_ARTIFACTS_DIR: string };
  capture(): Promise<void>;
  discard(): Promise<void>;
};

export function defaultSessionOutputsDir(home = homedir()): string {
  return join(home, ".auto-harness", "session-outputs");
}

function keyFor(sessionId: string, attemptId: string): string {
  return createHash("sha256").update(`${sessionId}\0${attemptId}`).digest("hex");
}

function outputError(code: string, message: string) {
  return {
    state: "error" as const,
    error: { code: code.slice(0, 64), message: message.slice(0, 256) },
  };
}

async function readOutput(path: string): Promise<SessionOutputSubmission> {
  try {
    const info = await lstat(path);
    if (!info.isFile())
      return outputError("invalid_output_file", "Output path is not a regular file");
    if (info.size > MAX_SESSION_OUTPUT_BYTES)
      return outputError("output_too_large", `Output exceeds ${MAX_SESSION_OUTPUT_BYTES} bytes`);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) {
      await handle.close();
      return outputError("invalid_output_file", "Output path is not a regular file");
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    try {
      const stream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: MAX_SESSION_OUTPUT_BYTES,
      });
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > MAX_SESSION_OUTPUT_BYTES) break;
        chunks.push(bytes);
      }
    } finally {
      await handle.close();
    }
    if (byteLength > MAX_SESSION_OUTPUT_BYTES)
      return outputError("output_too_large", `Output exceeds ${MAX_SESSION_OUTPUT_BYTES} bytes`);
    const after = await lstat(path);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      return outputError("output_changed", "Output changed while being read");
    if (byteLength === 0) return outputError("invalid_json", "Output file is empty");
    const bytes = Buffer.concat(chunks, byteLength);
    if (bytes.byteLength > MAX_SESSION_OUTPUT_BYTES)
      return outputError("output_too_large", `Output exceeds ${MAX_SESSION_OUTPUT_BYTES} bytes`);
    const jsonText = bytes.toString("utf8");
    if (!Buffer.from(jsonText, "utf8").equals(bytes))
      return outputError("invalid_output_encoding", "Output must be valid UTF-8");
    try {
      JSON.parse(jsonText);
    } catch {
      return outputError("invalid_json", "Output file must contain valid JSON");
    }
    return { state: "ready", jsonText, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "none" };
    return outputError(
      "output_read_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

type TreeStat = { dev: number; ino: number; size: number; mtimeMs: number; mode: number };
type TreeEntry = {
  path: string;
  absolute: string;
  kind: "file" | "directory";
  size: number;
  stat: TreeStat;
  ancestors: Array<{ path: string; dev: number; ino: number; mtimeMs: number }>;
};

async function listArtifacts(
  root: string,
): Promise<{ entries: TreeEntry[]; sourceBytes: number; fileCount: number }> {
  const entries: TreeEntry[] = [];
  const suppliedRoot = await lstat(root);
  if (!suppliedRoot.isDirectory() || suppliedRoot.isSymbolicLink())
    throw new Error("artifact root must be a real directory");
  const rootPath = await realpath(root);
  const directoryQueue: Array<{
    absolute: string;
    relativePath: string;
    ancestors: Array<{ path: string; dev: number; ino: number; mtimeMs: number }>;
  }> = [{ absolute: rootPath, relativePath: "", ancestors: [] }];
  let sourceBytes = 0;
  let fileCount = 0;
  let traversed = 0;
  for (let queueIndex = 0; queueIndex < directoryQueue.length; queueIndex += 1) {
    const directory = directoryQueue[queueIndex]!;
    const children: string[] = [];
    const handle = await opendir(directory.absolute);
    for await (const child of handle) {
      traversed += 1;
      if (traversed > MAX_SESSION_ARTIFACT_FILES * 2)
        throw new Error("artifact entry count exceeds traversal limit");
      children.push(child.name);
    }
    const sortedChildren = children.toSorted((a, b) => a.localeCompare(b));
    const dirStat = await lstat(directory.absolute);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
      throw new Error("artifact directory changed during scan");
    const ancestors = [
      ...directory.ancestors,
      { path: directory.absolute, dev: dirStat.dev, ino: dirStat.ino, mtimeMs: dirStat.mtimeMs },
    ];
    for (const name of sortedChildren) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\"))
        throw new Error("artifact path contains an unsafe component");
      const absolute = join(directory.absolute, name);
      const info = await lstat(absolute);
      const path = directory.relativePath ? `${directory.relativePath}/${name}` : name;
      if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${path}`);
      const snapshot = {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
      };
      if (info.isDirectory()) {
        entries.push({ path, absolute, kind: "directory", size: 0, stat: snapshot, ancestors });
        directoryQueue.push({ absolute, relativePath: path, ancestors });
      } else if (info.isFile()) {
        fileCount += 1;
        sourceBytes += info.size;
        if (fileCount > MAX_SESSION_ARTIFACT_FILES)
          throw new Error("artifact file count exceeds limit");
        if (sourceBytes > MAX_SESSION_ARTIFACT_SOURCE_BYTES)
          throw new Error("artifact source bytes exceed limit");
        entries.push({ path, absolute, kind: "file", size: info.size, stat: snapshot, ancestors });
      } else {
        throw new Error(`special files are not allowed: ${path}`);
      }
    }
  }
  if ((await realpath(root)) !== rootPath) throw new Error("artifact root changed during scan");
  return { entries, sourceBytes, fileCount };
}

async function createArchive(
  root: string,
  destination: string,
): Promise<{ bytes: number; sourceBytes: number; fileCount: number; sha256: string }> {
  const { entries, sourceBytes, fileCount } = await listArtifacts(root);
  if (fileCount === 0) return { bytes: 0, sourceBytes: 0, fileCount: 0, sha256: "" };
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const tar = createTar();
  const gzip = createGzip();
  const frozenRoot = await realpath(root);
  let compressedBytes = 0;
  let compressionLimitError: Error | undefined;
  const compressedLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > MAX_SESSION_ARTIFACT_BYTES) {
        compressionLimitError = new Error(
          `compressed artifacts exceed ${MAX_SESSION_ARTIFACT_BYTES} bytes`,
        );
        callback(compressionLimitError);
      } else callback(null, chunk);
    },
  });
  const archiveDone = pipeline(tar, gzip, compressedLimit, output);
  void archiveDone.catch(() => undefined);
  try {
    for (const entry of entries) {
      if ((await realpath(root)) !== frozenRoot)
        throw new Error("artifact root changed while archiving");
      for (const ancestor of entry.ancestors) {
        const info = await lstat(ancestor.path);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.dev !== ancestor.dev ||
          info.ino !== ancestor.ino ||
          info.mtimeMs !== ancestor.mtimeMs
        )
          throw new Error(`artifact parent changed while archiving: ${entry.path}`);
      }
      const before = await lstat(entry.absolute);
      if (
        before.isSymbolicLink() ||
        (entry.kind === "file" ? !before.isFile() : !before.isDirectory()) ||
        before.dev !== entry.stat.dev ||
        before.ino !== entry.stat.ino ||
        before.size !== entry.stat.size ||
        before.mtimeMs !== entry.stat.mtimeMs
      )
        throw new Error(`artifact changed before archive: ${entry.path}`);
      const stream = tar.entry({
        name: entry.path,
        type: entry.kind,
        size: entry.kind === "file" ? entry.size : 0,
        mode: entry.stat.mode & 0o777,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
      });
      if (entry.kind === "file") {
        const handle = await open(entry.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (
            opened.dev !== entry.stat.dev ||
            opened.ino !== entry.stat.ino ||
            opened.size !== entry.size
          )
            throw new Error(`artifact changed before read: ${entry.path}`);
          const fileStream = handle.createReadStream({ autoClose: false });
          let readBytes = 0;
          fileStream.on("data", (chunk: Buffer) => {
            readBytes += chunk.byteLength;
            if (readBytes > entry.size || readBytes > MAX_SESSION_ARTIFACT_SOURCE_BYTES)
              fileStream.destroy(new Error(`artifact grew while archiving: ${entry.path}`));
          });
          await pipeline(fileStream, stream);
          if (readBytes !== entry.size)
            throw new Error(`artifact changed while archiving: ${entry.path}`);
        } finally {
          await handle.close();
        }
        const after = await lstat(entry.absolute);
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        )
          throw new Error(`artifact changed while archiving: ${entry.path}`);
      } else {
        const after = await lstat(entry.absolute);
        if (
          !after.isDirectory() ||
          after.isSymbolicLink() ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.mtimeMs !== before.mtimeMs
        )
          throw new Error(`artifact directory changed while archiving: ${entry.path}`);
        stream.end(Buffer.alloc(0));
        await finished(stream);
      }
    }
    tar.finalize();
    await archiveDone;
  } catch (error) {
    tar.destroy();
    gzip.destroy();
    compressedLimit.destroy();
    output.destroy();
    await archiveDone.catch(() => undefined);
    await rm(destination, { force: true });
    throw compressionLimitError ?? error;
  }
  const info = await stat(destination);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(destination)) digest.update(chunk);
  return { bytes: info.size, sourceBytes, fileCount, sha256: digest.digest("hex") };
}

function apiHeaders(identity: Identity): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(identity.apiKey ? { authorization: `Bearer ${identity.apiKey}` } : {}),
  };
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function uploadBody(
  fields: Record<string, string>,
  archivePath: string,
): { body: NodeJS.ReadableStream; contentType: string } {
  const boundary = `harness-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex")}`;
  async function* parts() {
    for (const [name, value] of Object.entries(fields))
      yield Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    yield Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="artifacts.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
    );
    for await (const chunk of createReadStream(archivePath)) yield Buffer.from(chunk);
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }
  return { body: ReadableFrom(parts()), contentType: `multipart/form-data; boundary=${boundary}` };
}

function ReadableFrom(parts: AsyncIterable<Buffer>): NodeJS.ReadableStream {
  return Readable.from(parts);
}

async function uploadArtifact(input: {
  fetchFn: typeof fetch;
  upload: NonNullable<PrepareSessionOutputsResponse["artifactUpload"]>;
  identity: Identity;
  archivePath: string;
}): Promise<void> {
  const { upload } = input;
  if (Date.parse(upload.expiresAt) <= Date.now()) throw new Error("artifact upload URL expired");
  let response: Response;
  if (upload.method === "PUT") {
    response = await fetchWithTimeout(
      input.fetchFn,
      upload.url,
      {
        method: "PUT",
        headers: {
          ...upload.headers,
          ...(input.identity.apiKey ? { authorization: `Bearer ${input.identity.apiKey}` } : {}),
        },
        body: createReadStream(input.archivePath) as never,
        duplex: "half",
      } as RequestInit,
      SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS,
    );
  } else {
    const multipart = uploadBody(upload.fields, input.archivePath);
    response = await fetchWithTimeout(
      input.fetchFn,
      upload.url,
      {
        method: "POST",
        headers: { "content-type": multipart.contentType },
        body: multipart.body as never,
        duplex: "half",
      } as RequestInit,
      SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS,
    );
  }
  if (!response.ok) throw new Error(`artifact upload failed with HTTP ${response.status}`);
}

export class SessionOutputSpool {
  readonly root: string;
  private readonly identity: Identity | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly onLog: (message: string) => void;
  private readonly now: () => number;
  private readonly jobsDir: string;
  private readonly attemptsDir: string;
  private readonly errorsDir: string;
  private running = false;
  private passPromise: Promise<void> | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private cursor = "";
  private admissionTail: Promise<void> = Promise.resolve();
  private archiveReservedBytes = 0;

  constructor(input: {
    root?: string;
    identity?: Identity;
    fetchFn?: typeof fetch;
    onLog?: (message: string) => void;
    now?: () => number;
  }) {
    this.root = input.root ?? defaultSessionOutputsDir();
    this.identity = input.identity;
    this.fetchFn = input.fetchFn ?? FETCH;
    this.onLog = input.onLog ?? (() => undefined);
    this.now = input.now ?? Date.now;
    this.jobsDir = join(this.root, "jobs");
    this.attemptsDir = join(this.root, "attempts");
    this.errorsDir = join(this.root, "errors");
  }

  async begin(sessionId: string, attemptId: string): Promise<SessionOutputAttempt> {
    const key = keyFor(sessionId, attemptId);
    const directory = join(this.attemptsDir, key);
    await mkdir(this.attemptsDir, { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(join(directory, "intent.json"), "utf8")) as {
        sessionId?: unknown;
        attemptId?: unknown;
      };
      if (existing.sessionId !== sessionId || existing.attemptId !== attemptId)
        throw new Error("session output attempt directory has a mismatched intent", {
          cause: error,
        });
      if (
        await lstat(join(directory, "job.json")).then(
          () => true,
          () => false,
        )
      )
        throw new Error("session output attempt was already captured", { cause: error });
      await rm(join(directory, "output.json"), { force: true });
      await rm(join(directory, "artifacts"), { recursive: true, force: true });
    }
    await mkdir(join(directory, "artifacts"), { recursive: false, mode: 0o700 });
    await chmodDirectory(directory);
    const begunAt = new Date(this.now()).toISOString();
    await writeAtomic(
      join(directory, "intent.json"),
      JSON.stringify({ sessionId, attemptId, begunAt }),
    );
    return this.createAttemptHandle(directory, key, sessionId, attemptId);
  }

  async findDeferredAttempt(
    sessionId: string,
    attemptId: string,
  ): Promise<SessionOutputAttempt | undefined> {
    const key = keyFor(sessionId, attemptId);
    if (!/^[a-f0-9]{64}$/.test(key)) return undefined;
    const directory = join(this.attemptsDir, key);
    try {
      const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8")) as {
        sessionId?: unknown;
        attemptId?: unknown;
      };
      if (intent.sessionId !== sessionId || intent.attemptId !== attemptId) return undefined;
      return this.createAttemptHandle(directory, key, sessionId, attemptId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.onLog(`deferred session output recovery failed for ${sessionId}: ${String(error)}`);
      return undefined;
    }
  }

  private createAttemptHandle(
    directory: string,
    key: string,
    sessionId: string,
    attemptId: string,
  ): SessionOutputAttempt {
    const outputFile = join(directory, "output.json");
    let captured = false;
    return {
      jobId: key,
      env: { HARNESS_OUTPUT_FILE: outputFile, HARNESS_ARTIFACTS_DIR: join(directory, "artifacts") },
      discard: async () => {
        if (captured) return;
        captured = true;
        await rm(directory, { recursive: true, force: true });
      },
      capture: async () => {
        if (captured) return;
        captured = true;
        let output = await readOutput(outputFile);
        const readyDir = join(this.jobsDir, `${key}.ready`);
        const jobPath = join(directory, "job.json");
        const now = this.now();
        const capturedAt = new Date(now).toISOString();
        const job: Job = {
          sessionId,
          attemptId,
          capturedAt,
          completedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + SESSION_OUTPUT_RETRY_WINDOW_MS).toISOString(),
          output,
          artifactSource: join(readyDir, "artifacts"),
          retryAt: now,
          failures: 0,
        };
        if (output.state === "ready") {
          const size = Buffer.byteLength(output.jsonText, "utf8");
          if (size > MAX_SESSION_OUTPUT_BYTES)
            output = outputError("output_too_large", "Output exceeds limit");
          job.output = output;
        }
        await this.withAdmission(async () => {
          await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
          const { names: jobEntries, overflow } = await boundedNames(this.jobsDir, JOB_LIMIT + 1);
          const jobCount = jobEntries.filter((name) => name.endsWith(".ready")).length;
          const stagingBytes = await directoryBytes(this.root, STAGING_LIMIT);
          if (overflow || jobCount >= JOB_LIMIT || stagingBytes > STAGING_LIMIT) {
            await this.writePersistentError(
              job,
              "spool_capacity",
              "Local output spool capacity is exhausted",
            );
            await rm(directory, { recursive: true, force: true });
            return;
          }
          await writeAtomic(jobPath, JSON.stringify(job));
          await rename(directory, readyDir);
          if (job.artifactError) await rm(job.artifactSource, { force: true, recursive: true });
        });
        this.wake();
      },
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.recoverAbandonedAttempts().catch((error: unknown) => {
      this.onLog(`session output recovery scan failed: ${String(error)}`);
    });
    this.wake();
  }

  private async recoverAbandonedAttempts(): Promise<void> {
    const { names, overflow } = await boundedNames(this.attemptsDir, JOB_LIMIT);
    if (overflow) this.onLog(`session output attempt directory exceeds ${JOB_LIMIT} entries`);
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const directory = join(this.attemptsDir, name);
      try {
        const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8")) as {
          sessionId?: unknown;
          attemptId?: unknown;
          begunAt?: unknown;
        };
        const begunAt =
          typeof intent.begunAt === "string" ? Date.parse(intent.begunAt) : Number.NaN;
        if (
          typeof intent.sessionId === "string" &&
          typeof intent.attemptId === "string" &&
          Number.isFinite(begunAt) &&
          begunAt + SESSION_OUTPUT_RETRY_WINDOW_MS <= this.now()
        ) {
          const now = this.now();
          const job: Job = {
            sessionId: intent.sessionId,
            attemptId: intent.attemptId,
            capturedAt: new Date(now).toISOString(),
            completedAt: new Date(now).toISOString(),
            expiresAt: new Date(now).toISOString(),
            output: outputError(
              "daemon_interrupted",
              "Daemon restarted before outputs were captured",
            ),
            artifactSource: join(directory, "artifacts"),
            retryAt: now,
            failures: 0,
          };
          await this.writePersistentError(
            job,
            "daemon_interrupted",
            "Daemon restarted before outputs were captured",
          );
          await rm(directory, { recursive: true, force: true });
        }
      } catch (error) {
        this.onLog(`session output intent recovery failed for ${name}: ${String(error)}`);
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  wake(): void {
    if (!this.running || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.runPass();
    }, 0);
  }

  async runPass(): Promise<void> {
    if (this.passPromise) return await this.passPromise;
    this.passPromise = this.processPass()
      .catch((error: unknown) => {
        this.onLog(`session output spool pass failed: ${String(error)}`);
      })
      .finally(() => {
        this.passPromise = undefined;
        if (this.running)
          this.wakeTimer = setTimeout(() => {
            this.wakeTimer = undefined;
            this.wake();
          }, 1_000);
      });
    return await this.passPromise;
  }

  private async processPass(): Promise<void> {
    if (!this.identity?.apiUrl) return;
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    const { names: bounded, overflow } = await boundedNames(this.jobsDir, JOB_LIMIT + 1);
    if (overflow) this.onLog(`session output spool contains more than ${JOB_LIMIT} job entries`);
    const names = bounded
      .filter((name) => name.endsWith(".ready"))
      .toSorted()
      .slice(0, JOB_LIMIT);
    if (!names.length) return;
    const afterCursor = names.filter((name) => name > this.cursor);
    const selected = [...afterCursor, ...names.filter((name) => name <= this.cursor)].slice(
      0,
      PASS_LIMIT,
    );
    for (let index = 0; index < selected.length; index += CONCURRENCY) {
      await Promise.all(
        selected.slice(index, index + CONCURRENCY).map(async (name) => {
          this.cursor = name;
          await this.processJob(join(this.jobsDir, name));
        }),
      );
    }
  }

  private async processJob(directory: string): Promise<void> {
    const path = join(directory, "job.json");
    let job: Job;
    try {
      job = JSON.parse(await readFile(path, "utf8")) as Job;
    } catch (error) {
      this.onLog(`session outputs spool metadata unreadable: ${String(error)}`);
      return;
    }
    const now = this.now();
    if (Date.parse(job.expiresAt) <= now) {
      await this.writePersistentError(
        job,
        "retry_window_expired",
        "Output could not be published before the 24-hour deadline",
      );
      await rm(directory, { recursive: true, force: true });
      this.onLog(`session outputs retry window expired for ${job.sessionId}`);
      return;
    }
    if (job.retryAt > now) return;
    let artifact = job.artifact;
    let artifactError = job.artifactError;
    const archivePath = join(directory, "artifacts.tar.gz");
    if (!artifact && !artifactError) {
      try {
        await this.reserveArchiveSpace();
        let archive: Awaited<ReturnType<typeof createArchive>>;
        try {
          archive = await createArchive(job.artifactSource, archivePath);
        } finally {
          await this.withAdmission(async () => {
            this.archiveReservedBytes -= MAX_SESSION_ARTIFACT_BYTES;
          });
        }
        artifact =
          archive.fileCount === 0
            ? undefined
            : {
                state: "pending",
                compressedBytes: archive.bytes,
                sourceBytes: archive.sourceBytes,
                fileCount: archive.fileCount,
                sha256: archive.sha256,
              };
      } catch (error) {
        artifactError = { code: "artifact_capture_failed", message: String(error).slice(0, 256) };
        await rm(archivePath, { force: true });
      }
      if (artifact) job.artifact = artifact;
      else delete job.artifact;
      if (artifactError) job.artifactError = artifactError;
      else delete job.artifactError;
      await writeAtomic(path, JSON.stringify(job));
    }
    const artifacts: SessionArtifactsSubmission = artifactError
      ? { state: "error", error: artifactError }
      : artifact
        ? artifact
        : { state: "none" };
    const request: PrepareSessionOutputsRequest = {
      attemptId: job.attemptId,
      capturedAt: job.capturedAt,
      output: job.output,
      artifacts,
    };
    const endpoint = `${httpBaseFromApiUrl(this.identity!.apiUrl)}/api/v1/sessions/${encodeURIComponent(job.sessionId)}/outputs/prepare`;
    try {
      const response = await fetchWithTimeout(
        this.fetchFn,
        endpoint,
        {
          method: "POST",
          headers: apiHeaders(this.identity!),
          body: JSON.stringify(request),
        },
        API_TIMEOUT_MS,
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        const code = errorCode(body);
        if (
          response.status === 404 ||
          response.status === 410 ||
          code === "STALE_ATTEMPT" ||
          code === "RETENTION_STARTED" ||
          code === "OUTPUT_CONFLICT"
        ) {
          await rm(directory, { recursive: true, force: true });
          this.onLog(`session outputs discarded for ${job.sessionId}: ${code ?? response.status}`);
          return;
        }
        throw new Error(`prepare failed HTTP ${response.status}${code ? ` ${code}` : ""}`);
      }
      const prepared = body as PrepareSessionOutputsResponse;
      if (prepared?.artifactUpload) {
        if (!artifact) throw new Error("server requested artifact upload without a local archive");
        await uploadArtifact({
          fetchFn: this.fetchFn,
          upload: prepared.artifactUpload,
          identity: this.identity!,
          archivePath,
        });
      }
      const completeUrl = `${httpBaseFromApiUrl(this.identity!.apiUrl)}/api/v1/sessions/${encodeURIComponent(job.sessionId)}/outputs/complete`;
      const complete = await fetchWithTimeout(
        this.fetchFn,
        completeUrl,
        {
          method: "POST",
          headers: apiHeaders(this.identity!),
          body: JSON.stringify({ attemptId: job.attemptId }),
        },
        API_TIMEOUT_MS,
      );
      if (!complete.ok) {
        let completeBody: unknown;
        try {
          completeBody = await complete.json();
        } catch {
          completeBody = undefined;
        }
        const code = errorCode(completeBody);
        if (
          complete.status === 404 ||
          complete.status === 410 ||
          code === "STALE_ATTEMPT" ||
          code === "RETENTION_STARTED" ||
          code === "OUTPUT_CONFLICT"
        ) {
          await rm(directory, { recursive: true, force: true });
          return;
        }
        throw new Error(`complete failed HTTP ${complete.status}${code ? ` ${code}` : ""}`);
      }
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      job.failures += 1;
      const base = Math.min(RETRY_MAX_MS, 1_000 * 2 ** Math.min(job.failures, 8));
      job.retryAt = now + Math.min(RETRY_MAX_MS, base * (0.75 + Math.random() * 0.5));
      await writeAtomic(path, JSON.stringify(job)).catch(() => undefined);
      this.onLog(
        `session outputs publish failed for ${job.sessionId}; retry queued: ${String(error)}`,
      );
    }
  }

  private async writePersistentError(job: Job, code: string, message: string): Promise<void> {
    await mkdir(this.errorsDir, { recursive: true, mode: 0o700 });
    const id = keyFor(job.sessionId, job.attemptId);
    const { names } = await boundedNames(this.errorsDir, ERROR_RECORD_LIMIT + 1);
    for (const name of names) {
      if (name === "overflow.json") continue;
      const errorPath = join(this.errorsDir, name);
      let storedAt = Number.NaN;
      try {
        const stored = JSON.parse(await readFile(errorPath, "utf8")) as { at?: string };
        storedAt = Date.parse(stored.at ?? "");
      } catch {
        storedAt = Number.NEGATIVE_INFINITY;
      }
      if (storedAt + ERROR_RECORD_RETENTION_MS <= this.now()) await rm(errorPath, { force: true });
    }
    const retained = (await boundedNames(this.errorsDir, ERROR_RECORD_LIMIT + 1)).names.filter(
      (name) => name.endsWith(".json") && name !== "overflow.json" && name !== `${id}.json`,
    );
    if (retained.length >= ERROR_RECORD_LIMIT) {
      const overflowPath = join(this.errorsDir, "overflow.json");
      let count = 0;
      try {
        count = (JSON.parse(await readFile(overflowPath, "utf8")) as { count?: number }).count ?? 0;
      } catch {
        count = 0;
      }
      await writeAtomic(
        overflowPath,
        JSON.stringify({ count: count + 1, at: new Date(this.now()).toISOString() }),
      );
      this.onLog(
        `session outputs persistent error record cap reached (${code}) for ${job.sessionId}`,
      );
      return;
    }
    await writeAtomic(
      join(this.errorsDir, `${id}.json`),
      JSON.stringify({
        sessionId: job.sessionId,
        attemptId: job.attemptId,
        at: new Date(this.now()).toISOString(),
        code,
        message,
      }),
    );
    this.onLog(`session outputs persistent error for ${job.sessionId}: ${code}`);
  }

  private async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async reserveArchiveSpace(): Promise<void> {
    await this.withAdmission(async () => {
      const stagingBytes = await directoryBytes(this.root, STAGING_LIMIT);
      if (stagingBytes + this.archiveReservedBytes + MAX_SESSION_ARTIFACT_BYTES > STAGING_LIMIT)
        throw new Error("local output spool capacity cannot reserve artifact archive space");
      this.archiveReservedBytes += MAX_SESSION_ARTIFACT_BYTES;
    });
  }
}

async function chmodDirectory(path: string): Promise<void> {
  await import("node:fs/promises").then(({ chmod }) => chmod(path, 0o700));
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function directoryBytes(path: string, cap: number): Promise<number> {
  let total = 0;
  const stack = [path];
  let visited = 0;
  while (stack.length && total <= cap && visited < 100_000) {
    const current = stack.pop()!;
    const directory = await opendir(current).catch(() => undefined);
    if (!directory) continue;
    for await (const entry of directory) {
      visited += 1;
      if (visited >= 100_000) return cap + 1;
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const info = await lstat(full).catch(() => undefined);
        if (info?.isFile()) total += info.size;
        if (total > cap) break;
      }
    }
  }
  return total;
}

async function boundedNames(
  path: string,
  cap: number,
): Promise<{ names: string[]; overflow: boolean }> {
  const directory = await opendir(path).catch(() => undefined);
  if (!directory) return { names: [], overflow: false };
  const names: string[] = [];
  for await (const entry of directory) {
    names.push(entry.name);
    if (names.length > cap) return { names: names.slice(0, cap), overflow: true };
  }
  return { names, overflow: false };
}
