import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";

const USAGE =
  "usage: auto-harness repo add --name <name> --url <url> [--default-branch <branch>] [--json]";

/**
 * `POST /repositories`. The response is the created repository record itself — no `{ repository
 * }` wrapper, matching `GET /repositories/<id>` — so `--json` prints it verbatim. Human output
 * is one line (id, name), mirroring `repo list`'s per-line format.
 */
export async function runRepoAdd(argv, io) {
  const { flags, positionals } = parseFlags(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, "--name", "--url", "--default-branch"],
    booleanFlags: [...GLOBAL_BOOLEAN_FLAGS, "--json"],
  });
  if (positionals.length > 0 || !flags["--name"] || !flags["--url"]) {
    throw new CliUsageError(USAGE);
  }
  const client = await createClient(flags, io);
  const repository = await client.request("/repositories", {
    method: "POST",
    body: JSON.stringify({
      name: flags["--name"],
      url: flags["--url"],
      ...(flags["--default-branch"] !== undefined
        ? { defaultBranch: flags["--default-branch"] }
        : {}),
    }),
  });
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(repository, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`${repository.id}  ${repository.name}\n`);
  return 0;
}
