import {
  renderEnvFile,
  isProductionApiUrl,
  serviceEnv,
  updatePersistedApiUrl,
  validatePersistedEnvFile,
} from "./host-service-env.ts";
import { parseChildEnvAllowlist } from "./child-env.ts";

export function preparePersistedEnv(opts: {
  existing: string | undefined;
  example: string;
  env: NodeJS.ProcessEnv;
  apiUrl?: string | undefined;
  capturePath?: boolean | undefined;
}): { contents: string; errors: string[] } {
  if (opts.apiUrl !== undefined && !isProductionApiUrl(opts.apiUrl)) {
    const errors =
      opts.existing === undefined ? ["HARNESS_API_URL"] : validatePersistedEnvFile(opts.existing);
    if (!errors.includes("HARNESS_API_URL")) errors.push("HARNESS_API_URL");
    return { contents: opts.existing ?? "", errors };
  }
  let contents: string;
  if (opts.existing === undefined) {
    const env = serviceEnv(opts.env, opts.apiUrl);
    const childEnvErrors = parseChildEnvAllowlist(env).errors;
    if (childEnvErrors.length > 0) return { contents: "", errors: childEnvErrors };
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
