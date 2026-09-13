import { posix, win32 } from "node:path";

/**
 * Absolute path using the install/target host's native semantics. Never infer
 * a platform from the untrusted path string itself.
 */
export function isNativeAbsolutePath(value: string, platform: string): boolean {
  return (platform === "win32" ? win32 : posix).isAbsolute(value);
}
