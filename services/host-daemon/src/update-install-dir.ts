import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Select a writable, stable update root for the platform supervisor. The
 * stable service launchers always resolve this directory's `current` pointer
 * at process start. Linux keeps its root-owned launcher alongside the update
 * tree; the installer separately grants the daemon user write access to the
 * release root.
 */
export function resolveUpdateInstallDir(
  env: NodeJS.ProcessEnv,
  options: { platform?: string; home?: string; appData?: string } = {},
): string {
  const configured = env.HARNESS_UPDATE_INSTALL_DIR?.trim();
  if (configured) return configured;

  const platform = options.platform ?? process.platform;
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
