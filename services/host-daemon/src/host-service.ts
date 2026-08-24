import { installDarwin, restartDarwin, uninstallDarwin } from "./host-service-darwin.ts";
import type { HostServiceOpts } from "./host-service-io.ts";
import { resolveHostService } from "./host-service-io.ts";
import { installLinux, restartLinux, uninstallLinux } from "./host-service-linux.ts";
import { installWin32, restartWin32, uninstallWin32 } from "./host-service-win32.ts";
import { statusDarwin } from "./host-service-darwin.ts";
import { statusLinux } from "./host-service-linux.ts";
import { statusWin32 } from "./host-service-win32.ts";

export type { HostServiceOpts } from "./host-service-io.ts";
export type { HostServiceStatus } from "./host-service-io.ts";

export function getHostServiceStatus(
  opts: HostServiceOpts,
): import("./host-service-io.ts").HostServiceStatus {
  try {
    const ctx = resolveHostService(opts);
    switch (ctx.platform) {
      case "linux":
        return statusLinux(ctx);
      case "darwin":
        return statusDarwin(ctx);
      case "win32":
        return statusWin32(ctx);
      default:
        return { state: "unknown", reason: `service status is unsupported on ${ctx.platform}` };
    }
  } catch {
    return { state: "unknown", reason: "service status could not be determined" };
  }
}

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

export function restartHostService(opts: HostServiceOpts): number {
  try {
    const ctx = resolveHostService(opts);
    switch (ctx.platform) {
      case "linux":
        return restartLinux(ctx);
      case "darwin":
        return restartDarwin(ctx);
      case "win32":
        return restartWin32(ctx);
      default:
        ctx.error(`service restart is not supported on ${ctx.platform}`);
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
