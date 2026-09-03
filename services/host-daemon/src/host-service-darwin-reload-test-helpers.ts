import { installHostService } from "./host-service.ts";
import type { HostServiceRun, HostServiceRunResult } from "./host-service-io.ts";
import { baseOpts, errRun, launchctlByStep, okRun, seededFs } from "./host-service-test-helpers.ts";

export const missing = errRun(1, "Could not find service");
export const running = okRun("state = running\npid = 100\n");
export const replacement = okRun("state = running\npid = 101\n");
export const stopped = okRun("state = stopped\n");

export function install(run: HostServiceRun) {
  const calls: string[] = [];
  const errors: string[] = [];
  const sleepArgs: string[][] = [];
  const code = installHostService(
    baseOpts({
      platform: "darwin",
      fs: seededFs(),
      error: (msg) => errors.push(msg),
      run: (command, args, opts) => {
        calls.push(command === "launchctl" ? (args[0] ?? command) : command);
        if (command === "/bin/sleep") sleepArgs.push(args);
        return run(command, args, opts);
      },
    }),
  );
  return { calls, code, errors, sleepArgs };
}

export function steps(
  replies: Record<string, HostServiceRunResult | HostServiceRunResult[]>,
): ReturnType<typeof install> {
  return install(launchctlByStep(replies));
}
