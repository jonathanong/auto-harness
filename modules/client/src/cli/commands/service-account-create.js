import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { allowlistAccount, formatAccountLine } from "../service-account-format.js";

const USAGE =
  "usage: auto-harness service-account create --name <name> --role <role> " +
  "[--bound-host <hostId>] [--repositories <id,id,...>] (--key-file <path> | --print-key) [--json]";

/**
 * `POST /auth/service-accounts`. The response's `apiKey` is shown exactly once — the server only
 * stores a hash — so `--key-file`/`--print-key` is a required, mutually-exclusive choice about
 * where that one-time value goes, validated (along with `--repositories`) before any request.
 */
export async function runServiceAccountCreate(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [
      ...GLOBAL_VALUE_FLAGS,
      "--name",
      "--role",
      "--bound-host",
      "--repositories",
      "--key-file",
    ],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--print-key", "--json"],
  });
  if (positionals.length > 0 || !flags["--name"] || !flags["--role"]) {
    throw new CliUsageError(USAGE);
  }
  const hasKeyFile = flags["--key-file"] !== undefined;
  const hasPrintKey = Boolean(flags["--print-key"]);
  if (hasKeyFile === hasPrintKey) {
    throw new CliUsageError("exactly one of --key-file or --print-key is required");
  }
  if (hasPrintKey && flags["--json"]) {
    throw new CliUsageError("--json and --print-key cannot be combined");
  }
  const allowedRepositoryIds = parseRepositories(flags["--repositories"]);
  if (hasKeyFile) await assertKeyFileAbsent(flags["--key-file"], io);
  const client = await createClient(flags, io);
  const result = await client.request("/auth/service-accounts", {
    method: "POST",
    body: JSON.stringify(buildBody(flags, allowedRepositoryIds)),
  });
  const account = allowlistAccount(result.account);
  return hasKeyFile
    ? finishKeyFile(io, flags["--key-file"], flags["--json"], account, result.apiKey)
    : finishPrintKey(io, account, result.apiKey);
}

function buildBody(flags, allowedRepositoryIds) {
  return {
    name: flags["--name"],
    role: flags["--role"],
    ...(flags["--bound-host"] !== undefined ? { boundHostId: flags["--bound-host"] } : {}),
    ...(allowedRepositoryIds !== undefined ? { allowedRepositoryIds } : {}),
  };
}

function parseRepositories(value) {
  if (value === undefined) return undefined;
  const ids = value.split(",");
  if (ids.some((id) => id === "")) {
    throw new CliUsageError("--repositories must be a comma-separated list with no empty entries");
  }
  return ids;
}

/** Best-effort pre-check so an obviously doomed request never fires; the atomic `wx` write in
 * `finishKeyFile` is the real guarantee against overwriting an existing file. */
async function assertKeyFileAbsent(path, io) {
  let exists = true;
  try {
    await io.readFile(path, "utf8");
  } catch {
    exists = false;
  }
  if (exists)
    throw new CliUsageError(`--key-file ${path} already exists; refusing to overwrite it`);
}

async function finishKeyFile(io, path, json, account, apiKey) {
  try {
    await io.writeFileExclusive(path, `${apiKey}\n`, { mode: 0o600 });
  } catch (error) {
    throw new Error(
      `service account ${account.id} was created but its key could not be written to ${path} ` +
        `(${error.message}); the key is now lost — remove it with ` +
        `\`auto-harness service-account rm ${account.id}\` and create a new one`,
      { cause: error },
    );
  }
  if (json) {
    io.stdout.write(`${JSON.stringify(account, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`service account ${account.id} created\nkey written to ${path}\n`);
  return 0;
}

function finishPrintKey(io, account, apiKey) {
  io.stderr.write(`${formatAccountLine(account)}\n`);
  io.stdout.write(`${apiKey}\n`);
  return 0;
}
