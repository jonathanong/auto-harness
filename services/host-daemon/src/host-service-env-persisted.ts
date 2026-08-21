import {
  renderEnvFile,
  serviceEnv,
  updatePersistedApiUrl,
  validatePersistedEnvFile,
} from "./host-service-env.ts";

export function preparePersistedEnv(opts: {
  existing: string | undefined;
  example: string;
  env: NodeJS.ProcessEnv;
  apiUrl?: string | undefined;
  capturePath?: boolean | undefined;
}): { contents: string; errors: string[] } {
  let contents: string;
  if (opts.existing === undefined) {
    const env = serviceEnv(opts.env, opts.apiUrl);
    contents =
      opts.capturePath === undefined
        ? renderEnvFile(opts.example, env)
        : renderEnvFile(opts.example, env, { capturePath: opts.capturePath });
  } else if (opts.apiUrl === undefined) {
    contents = opts.existing;
  } else {
    contents = updatePersistedApiUrl(opts.existing, opts.apiUrl);
  }
  return { contents, errors: validatePersistedEnvFile(contents) };
}
