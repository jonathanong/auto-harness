import { installDarwin, uninstallDarwin } from "./host-service-darwin.ts";
import type { HostServiceOpts } from "./host-service-io.ts";
import { resolveHostService } from "./host-service-io.ts";
import { installLinux, uninstallLinux } from "./host-service-linux.ts";
import { installWin32, uninstallWin32 } from "./host-service-win32.ts";

export type { HostServiceOpts } from "./host-service-io.ts";

export function installHostService(opts: HostServiceOpts): number {
  try {
    const ctx = resolveHostService(opts);
    switch (ctx.platform) {
      case "linux":
        return installLinux(ctx);
      case "darwin":
        return installDarwin(ctx);
      case "win32":
        return installWin32(ctx);
      default:
        ctx.error(`install-service is not supported on ${ctx.platform}`);
        return 1;
    }
  } catch (err) {
    opts.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function uninstallHostService(opts: HostServiceOpts): number {
  try {
    const ctx = resolveHostService(opts);
    switch (ctx.platform) {
      case "linux":
        return uninstallLinux(ctx);
      case "darwin":
        return uninstallDarwin(ctx);
      case "win32":
        return uninstallWin32(ctx);
      default:
        ctx.error(`uninstall-service is not supported on ${ctx.platform}`);
        return 1;
    }
  } catch (err) {
    opts.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
