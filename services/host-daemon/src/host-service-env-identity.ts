import { envIdentityErrors } from "./host-service-env.ts";

export function warnOrRefuseIdentity(opts: {
  env: NodeJS.ProcessEnv;
  platform: string;
  error: (msg: string) => void;
  log: (msg: string) => void;
}): number {
  const gaps = envIdentityErrors(opts.env, opts.platform);
  if (gaps.length === 0) return 0;
  const detail = `set ${gaps.join(", ")} to real bound values (not placeholders or local defaults)`;
  if (opts.platform === "linux") {
    opts.error(`Refusing to write a new env file: ${detail}`);
    return 1;
  }
  opts.log(`Warning: ${detail}`);
  return 0;
}
