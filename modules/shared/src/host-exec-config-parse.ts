export const EXEC_CONFIG_REQUIRED_MESSAGE =
  "fleet:exec-config is required to change setup scripts or executable paths";

export const MAX_ALLOWED_ROOTS = 32;
export const MAX_EXEC_PATH_LENGTH = 4096;

export type HostExecConfigPatch = {
  setupScript?: string | undefined;
  allowedRoots?: string[] | undefined;
  repositories?: HostExecRepositoryPatch[] | undefined;
};

export type HostExecRepositoryPatch = {
  id: string;
  setupScript?: string | undefined;
  terminalHookScript?: string | undefined;
  worktrees?: HostExecWorktreePatch[] | undefined;
};

export type HostExecWorktreePatch = {
  id: string;
  setupScript?: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absolute POSIX, Windows drive, or UNC path — host OS is not known on the control plane. */
export function isAbsolutePathString(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Empty string clears a stored hook. Non-empty values must be absolute and bounded. */
export function parseTerminalHookScript(
  value: string | undefined,
  repositoryId: string,
  options: { allowLegacyRelative?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) return value;
  if (value.length > MAX_EXEC_PATH_LENGTH) {
    throw new TypeError(`repository.${repositoryId}.terminalHookScript is too long`);
  }
  if (!options.allowLegacyRelative && !isAbsolutePathString(value)) {
    throw new TypeError(`repository.${repositoryId}.terminalHookScript must be an absolute path`);
  }
  return value;
}

export function parseAllowedRoots(value: unknown, ctx = "allowedRoots"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${ctx} must be a string array`);
  }
  if (value.length > MAX_ALLOWED_ROOTS) {
    throw new TypeError(`${ctx} must contain at most ${String(MAX_ALLOWED_ROOTS)} paths`);
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (raw.length === 0 || raw.length > MAX_EXEC_PATH_LENGTH) {
      throw new TypeError(`${ctx} entries must be non-empty paths`);
    }
    if (!isAbsolutePathString(raw)) {
      throw new TypeError(`${ctx} entries must be absolute paths`);
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    roots.push(raw);
  }
  return roots;
}

function optionalPatchString(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string | undefined {
  if (!Object.hasOwn(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value !== "string") throw new TypeError(`${ctx}.${key} must be a string`);
  return value;
}

function parseExecWorktree(
  raw: unknown,
  index: number,
  repositoryId: string,
): HostExecWorktreePatch {
  if (!isRecord(raw)) {
    throw new TypeError(`repositories.${repositoryId}.worktrees[${String(index)}] invalid`);
  }
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(
      `repositories.${repositoryId}.worktrees[${String(index)}]: id must be a non-empty string`,
    );
  }
  const setupScript = optionalPatchString(raw, "setupScript", `worktree.${id}`);
  return { id, ...(setupScript !== undefined ? { setupScript } : {}) };
}

function parseExecRepository(raw: unknown, index: number): HostExecRepositoryPatch {
  if (!isRecord(raw)) throw new TypeError(`repositories[${String(index)}] must be an object`);
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(`repositories[${String(index)}]: id must be a non-empty string`);
  }
  const setupScript = optionalPatchString(raw, "setupScript", `repository.${id}`);
  const terminalHookScript = parseTerminalHookScript(
    optionalPatchString(raw, "terminalHookScript", `repository.${id}`),
    id,
  );
  let worktrees: HostExecWorktreePatch[] | undefined;
  if (Object.hasOwn(raw, "worktrees")) {
    if (!Array.isArray(raw.worktrees)) {
      throw new TypeError(`repository.${id}.worktrees must be an array`);
    }
    worktrees = raw.worktrees.map((worktree, worktreeIndex) =>
      parseExecWorktree(worktree, worktreeIndex, id),
    );
  }
  return {
    id,
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...(terminalHookScript !== undefined ? { terminalHookScript } : {}),
    ...(worktrees !== undefined ? { worktrees } : {}),
  };
}

/** Strictly parse an exec-config write. Omitted keys leave stored values unchanged. */
export function parseHostExecConfig(value: unknown): HostExecConfigPatch {
  if (!isRecord(value)) throw new TypeError("body must be an object");
  const setupScript = optionalPatchString(value, "setupScript", "exec-config");
  const allowedRoots = Object.hasOwn(value, "allowedRoots")
    ? (parseAllowedRoots(value.allowedRoots) ?? [])
    : undefined;
  let repositories: HostExecRepositoryPatch[] | undefined;
  if (Object.hasOwn(value, "repositories")) {
    if (!Array.isArray(value.repositories)) throw new TypeError("repositories must be an array");
    repositories = value.repositories.map((repository, index) =>
      parseExecRepository(repository, index),
    );
  }
  return {
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...(allowedRoots !== undefined ? { allowedRoots } : {}),
    ...(repositories !== undefined ? { repositories } : {}),
  };
}
