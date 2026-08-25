import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

/**
 * Select a stable update root for the platform supervisor. The stable service
 * launchers always resolve this directory's `current` pointer at process
 * start. Linux keeps immutable active releases separate from its writable
 * incoming artifacts and deployment checkout.
 */
export function resolveUpdateInstallDir(
  env: NodeJS.ProcessEnv,
  options: { platform?: string; home?: string; appData?: string } = {},
): string {
  const configured = env.HARNESS_UPDATE_INSTALL_DIR?.trim();
  const platform = options.platform ?? process.platform;
  if (configured) {
    const absolute = platform === "win32" ? win32.isAbsolute(configured) : isAbsolute(configured);
    if (!absolute) {
      throw new Error("HARNESS_UPDATE_INSTALL_DIR must be an absolute path");
    }
    return configured;
  }

  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "auto-harness", "updates");
  }
  if (platform === "win32") {
    const appData = options.appData ?? env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "auto-harness", "updates");
  }
  return "/opt/auto-harness";
}
