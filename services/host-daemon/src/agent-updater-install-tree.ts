import { existsSync, realpathSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REQUIRED_LAUNCHER = "services/host-daemon/bin/auto-harness-host-daemon.mjs";

function isContainedPath(root: string, path: string): boolean {
  return resolve(path).startsWith(`${resolve(root)}${sep}`);
}

function isPnpmDependencyPath(root: string, path: string): boolean {
  return relative(root, path).split(sep).includes("node_modules");
}

function assertSafeSymlinks(root: string, current = root, resolvedRoot = realpathSync(root)): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      assertSafeSymlink(root, path, resolvedRoot);
      continue;
    }
    if (entry.isDirectory()) assertSafeSymlinks(root, path, resolvedRoot);
  }
}

function assertSafeSymlink(root: string, path: string, resolvedRoot: string): void {
  if (!isPnpmDependencyPath(root, path)) {
    throw new Error("update archive contains a symbolic link outside node_modules");
  }
  const target = readlinkSync(path);
  const lexicalTarget = resolve(dirname(path), target);
  if (isAbsolute(target) || !isContainedPath(root, lexicalTarget)) {
    throw new Error("update archive contains a symbolic link outside its staging directory");
  }
  let resolvedTarget: string;
  try {
    resolvedTarget = realpathSync(path);
  } catch {
    throw new Error("update archive contains a broken symbolic link");
  }
  if (!isContainedPath(resolvedRoot, resolvedTarget)) {
    throw new Error("update archive contains a symbolic link outside its staging directory");
  }
}

export function assertRunnableTree(root: string): void {
  assertSafeSymlinks(root);
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, REQUIRED_LAUNCHER))) {
    throw new Error("update archive is not a runnable Auto Harness tree");
  }
}
