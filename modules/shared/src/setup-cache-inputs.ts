export const MAX_SETUP_CACHE_INPUTS = 32;
export const MAX_SETUP_CACHE_INPUT_LENGTH = 4096;

function isAbsoluteOrDriveQualified(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hostPathNames(path: string): string[] {
  const rest = path.split(/[\\/]/).slice(1);
  return rest[0] === "" ? rest.slice(1) : rest;
}

/** Relative checkout path the daemon may hash; never an operator-discovered manifest. */
export function isSetupCacheInputPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_SETUP_CACHE_INPUT_LENGTH) return false;
  if (hasControlChars(path) || path.includes("\\")) return false;
  if (isAbsoluteOrDriveQualified(path) || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Absolute host-owned file the daemon may hash; never an auto-detected sourced path. */
export function isSetupCacheHostInputPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_SETUP_CACHE_INPUT_LENGTH) return false;
  if (hasControlChars(path) || !isAbsoluteOrDriveQualified(path)) return false;
  const names = hostPathNames(path);
  return (
    names.length > 0 && names.every((name) => name.length > 0 && name !== "." && name !== "..")
  );
}

export function splitSetupCacheInputLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
}

function parsePathList(
  value: unknown,
  ctx: string,
  isValid: (path: string) => boolean,
  invalidMessage: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${ctx} must be a string array`);
  }
  if (value.length > MAX_SETUP_CACHE_INPUTS) {
    throw new TypeError(`${ctx} must contain at most ${String(MAX_SETUP_CACHE_INPUTS)} paths`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (raw.length === 0) {
      throw new TypeError(`${ctx} entries must be non-empty ${invalidMessage}`);
    }
    if (raw.length > MAX_SETUP_CACHE_INPUT_LENGTH) {
      throw new TypeError(
        `${ctx} entries must be at most ${String(MAX_SETUP_CACHE_INPUT_LENGTH)} characters`,
      );
    }
    if (!isValid(raw)) {
      throw new TypeError(`${ctx} entries must be ${invalidMessage}`);
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    paths.push(raw);
  }
  return paths;
}

/** Parse an operator-declared extra-file list. Empty arrays clear a stored value. */
export function parseSetupCacheInputs(value: unknown, ctx: string): string[] | undefined {
  return parsePathList(
    value,
    ctx,
    isSetupCacheInputPath,
    "relative paths without '..', '.', or absolute/drive-qualified prefixes",
  );
}

/** Parse operator-declared host-absolute files. Empty arrays clear a stored value. */
export function parseSetupCacheHostInputs(value: unknown, ctx: string): string[] | undefined {
  return parsePathList(
    value,
    ctx,
    isSetupCacheHostInputPath,
    "absolute host paths without '..' or '.' segments",
  );
}

export function presentSetupCacheInputs(value: unknown, ctx: string): string[] | undefined {
  const parsed = parseSetupCacheInputs(value, ctx);
  return parsed?.length ? parsed : undefined;
}

export function presentSetupCacheHostInputs(value: unknown, ctx: string): string[] | undefined {
  const parsed = parseSetupCacheHostInputs(value, ctx);
  return parsed?.length ? parsed : undefined;
}

export function parseSetupCacheInputsField(text: string, ctx: string): string[] {
  return parseSetupCacheInputs(splitSetupCacheInputLines(text), ctx)!;
}

export function parseSetupCacheHostInputsField(text: string, ctx: string): string[] {
  return parseSetupCacheHostInputs(splitSetupCacheInputLines(text), ctx)!;
}
