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

export function isRealArtifactDirectory(stat: ArtifactStat): boolean {
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
