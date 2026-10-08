export type ArtifactStat = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export type ArtifactStatSnapshot = Pick<ArtifactStat, "dev" | "ino" | "size" | "mtimeMs" | "mode">;
export type ArtifactRootSnapshot = Pick<ArtifactStat, "dev" | "ino"> & { path: string };

export function isOutputTooLarge(size: number, limit: number): boolean {
  return size > limit;
}

export async function collectBoundedOutput(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ chunks: Buffer[]; observedBytes: number }> {
  const chunks: Buffer[] = [];
  let observedBytes = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    observedBytes += bytes.byteLength;
    if (isOutputTooLarge(observedBytes, limit)) break;
    chunks.push(bytes);
  }
  return { chunks, observedBytes };
}

export function validateOutputReadSnapshot(input: {
  before: ArtifactStat;
  after: ArtifactStat;
  chunks: Buffer[];
  observedBytes: number;
}): { ok: true; jsonText: string; bytes: Buffer } | { ok: false; code: string; message: string } {
  if (outputFileChanged(input.before, input.after))
    return { ok: false, code: "output_changed", message: "Output changed while being read" };
  if (input.observedBytes === 0)
    return { ok: false, code: "invalid_json", message: "Output file is empty" };
  const bytes = Buffer.concat(input.chunks, input.observedBytes);
  const jsonText = bytes.toString("utf8");
  if (!Buffer.from(jsonText, "utf8").equals(bytes))
    return { ok: false, code: "invalid_output_encoding", message: "Output must be valid UTF-8" };
  try {
    JSON.parse(jsonText);
  } catch {
    return { ok: false, code: "invalid_json", message: "Output file must contain valid JSON" };
  }
  return { ok: true, jsonText, bytes };
}

export function outputFileChanged(before: ArtifactStat, after: ArtifactStat): boolean {
  return (
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  );
}

export function isSafeArtifactComponent(name: string): boolean {
  return (
    Boolean(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
  );
}

function isRealArtifactDirectory(stat: ArtifactStat): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

export function isRegularArtifactFile(stat: ArtifactStat): boolean {
  return stat.isFile() && !stat.isSymbolicLink();
}

export function assertRealArtifactDirectory(stat: ArtifactStat, message: string): void {
  if (!isRealArtifactDirectory(stat)) throw new Error(message);
}

export function assertArtifactRootUnchanged(
  before: ArtifactRootSnapshot,
  after: ArtifactRootSnapshot,
  message: string,
): void {
  if (before.path !== after.path || before.dev !== after.dev || before.ino !== after.ino)
    throw new Error(message);
}

export function assertArtifactParentUnchanged(
  expected: Pick<ArtifactStatSnapshot, "dev" | "ino" | "mtimeMs">,
  actual: ArtifactStat,
  message: string,
): void {
  if (
    !isRealArtifactDirectory(actual) ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.mtimeMs !== expected.mtimeMs
  )
    throw new Error(message);
}

export function assertArtifactEntryUnchanged(
  expected: ArtifactStatSnapshot,
  actual: ArtifactStat,
  kind: "file" | "directory",
  message: string,
): void {
  if (
    actual.isSymbolicLink() ||
    (kind === "file" ? !actual.isFile() : !isRealArtifactDirectory(actual)) ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs
  )
    throw new Error(message);
}

export function assertArtifactReadMatches(
  expectedBytes: number,
  readBytes: number,
  message: string,
): void {
  if (readBytes !== expectedBytes) throw new Error(message);
}

export function assertArtifactComponent(name: string, message: string): void {
  if (!isSafeArtifactComponent(name)) throw new Error(message);
}

export function artifactEntryKind(stat: ArtifactStat, message: string): "file" | "directory" {
  if (isRealArtifactDirectory(stat)) return "directory";
  if (isRegularArtifactFile(stat)) return "file";
  throw new Error(message);
}

export function assertOpenedArtifactUnchanged(
  expected: ArtifactStatSnapshot,
  actual: ArtifactStat,
  message: string,
): void {
  assertArtifactEntryUnchanged(expected, actual, "file", message);
}

export function artifactReadExceedsLimit(readBytes: number, size: number, limit: number): boolean {
  return readBytes > size || readBytes > limit;
}

export function abortArtifactReadIfTooLarge(
  stream: { destroy(error?: Error): unknown },
  readBytes: number,
  size: number,
  limit: number,
  path: string,
): void {
  if (artifactReadExceedsLimit(readBytes, size, limit))
    stream.destroy(new Error(`artifact grew while archiving: ${path}`));
}

export function preferArtifactLimitError(error: unknown, limitError: Error | undefined): unknown {
  return limitError ?? error;
}
