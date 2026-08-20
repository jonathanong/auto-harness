import { readFileSync } from "node:fs";

import type { HostServiceFs, HostServiceOpts, HostServiceRunResult } from "./host-service-io.ts";

export const unitTemplate = readFileSync(
  new URL("../systemd/auto-harness-host-daemon.service", import.meta.url),
  "utf8",
);
export const envExample = readFileSync(
  new URL("../systemd/host-daemon.env.example", import.meta.url),
  "utf8",
);

export type MemoryFs = HostServiceFs & {
  files: Map<string, string>;
  modes: Map<string, number>;
};

export function memFs(seed: Record<string, string> = {}): MemoryFs {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    existsSync: (path) => files.has(path) || dirs.has(path),
    mkdirSync: (path) => {
      dirs.add(path);
    },
    writeFileSync: (path, data, opts) => {
      files.set(path, data);
      modes.set(path, opts.mode);
    },
    readFileSync: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    chmodSync: (path, mode) => {
      modes.set(path, mode);
    },
    rmSync: (path) => {
      files.delete(path);
    },
  };
}

export function recorder(replies: Record<string, HostServiceRunResult> = {}) {
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    run(command: string, args: string[]): HostServiceRunResult {
      calls.push({ command, args });
      return replies[`${command} ${args.join(" ")}`] ?? { status: 0, stdout: "", stderr: "" };
    },
  };
}

export function baseOpts(
  partial: Partial<HostServiceOpts> & { fs: HostServiceFs },
): HostServiceOpts {
  return {
    env: {
      HARNESS_HOST_ID: "host-1",
      HARNESS_API_URL: "https://example.cloudfront.net",
      HARNESS_API_KEY: "secret",
    },
    log: () => undefined,
    error: () => undefined,
    checkoutRoot: "/checkout",
    nodePath: "/usr/bin/node",
    home: "/Users/op",
    appData: "/Users/op/AppData/Roaming",
    tmpDir: "/tmp",
    uid: 501,
    ...partial,
  };
}

export function seededFs(extra: Record<string, string> = {}): MemoryFs {
  return memFs({
    "/checkout/services/host-daemon/systemd/auto-harness-host-daemon.service": unitTemplate,
    "/checkout/services/host-daemon/systemd/host-daemon.env.example": envExample,
    ...extra,
  });
}
