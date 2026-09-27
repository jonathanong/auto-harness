import { constants } from "node:fs";
import { mkdtemp, open, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSessionFeedback,
  MAX_SESSION_FEEDBACK_BYTES,
  type SessionFeedback,
} from "@auto-harness/shared";

type Artifact = { directory: string; path: string };
const artifacts = new WeakMap<object, Artifact>();

/** The daemon selects this fresh per-attempt path; agents can write evidence, never choose identity. */
export async function prepareSessionFeedback(assign: object): Promise<string> {
  const existing = artifacts.get(assign);
  if (existing) return existing.path;
  const directory = await realpath(await mkdtemp(join(tmpdir(), "auto-harness-feedback-")));
  const path = join(directory, "feedback.json");
  artifacts.set(assign, { directory, path });
  return path;
}

/** No-follow open and fstat bind validation to the same file descriptor that is read. */
export async function readSessionFeedback(path: string): Promise<SessionFeedback | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if ((await realpath(path)) !== path) return undefined;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if ((await realpath(path)) !== path) return undefined;
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_FEEDBACK_BYTES || stat.nlink !== 1)
      return undefined;
    const bytes = Buffer.alloc(MAX_SESSION_FEEDBACK_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_SESSION_FEEDBACK_BYTES) return undefined;
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)),
    );
    return isSessionFeedback(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

export async function takeSessionFeedback(assign: object): Promise<SessionFeedback | undefined> {
  const artifact = artifacts.get(assign);
  if (!artifact) return undefined;
  artifacts.delete(assign);
  try {
    return await readSessionFeedback(artifact.path);
  } finally {
    await rm(artifact.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function snapshotSessionFeedback(
  assign: object,
): Promise<SessionFeedback | undefined> {
  const artifact = artifacts.get(assign);
  return artifact ? await readSessionFeedback(artifact.path) : undefined;
}
