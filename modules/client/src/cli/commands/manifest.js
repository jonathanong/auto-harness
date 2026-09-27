import { checkAdminLoginUsage } from "../admin-login.js";
import { parseFlags } from "../args.js";
import { CliUsageError } from "../cli-errors.js";
import { createClient, GLOBAL_BOOLEAN_FLAGS, GLOBAL_VALUE_FLAGS } from "../config.js";
import { formatUsageLine, managementCommands, usageUnder } from "../management-commands.js";
import { MAX_ALL_PAGES, collectAllPages } from "../page-all.js";
import { pathSegment } from "../path-segment.js";
import { readStdin } from "../read-stdin.js";

const HAND_DISPATCHED = new Set([
  "api",
  "whoami",
  "doctor",
  "host",
  "repo",
  "service-account",
  "session",
]);

export function isManifestRoot(command) {
  return managementCommands.some(
    (entry) => entry.argv?.[0] === command && !entry.via && !HAND_DISPATCHED.has(command),
  );
}

export function usageForRoot(root) {
  const lines = usageUnder([root]);
  return lines.length > 0
    ? `usage:\n${lines.join("\n")}`
    : `usage: auto-harness ${root} <subcommand>`;
}

function matchManifestCommand(tokens) {
  let best;
  for (const command of managementCommands) {
    if (!command.argv || command.via) continue;
    if (command.argv.length > tokens.length) continue;
    const matches = command.argv.every((part, index) => part === tokens[index]);
    if (!matches) continue;
    if (!best || command.argv.length > best.argv.length) best = command;
  }
  return best;
}

/** Runs a manifest command. Returns undefined when `tokens` match none, so callers can fall through. */
export async function runManifestCommand(tokens, io) {
  const command = matchManifestCommand(tokens);
  if (!command) return undefined;
  return execute(command, tokens.slice(command.argv.length), io);
}

async function execute(command, argv, io) {
  const valueFlags = [...GLOBAL_VALUE_FLAGS];
  const booleanFlags = [...GLOBAL_BOOLEAN_FLAGS];
  if (command.methods.length > 1) valueFlags.push("--method");
  for (const query of command.query) valueFlags.push(query.flag);
  for (const header of command.headers) valueFlags.push(header.flag);
  if (command.body === "optional" || command.body === "required" || command.body === "file") {
    valueFlags.push("--body", "--body-file");
  }
  if (command.paging) booleanFlags.push("--all");

  const { flags, positionals } = parseFlags(argv, { valueFlags, booleanFlags });
  if (positionals.length !== command.params.length) {
    throw new CliUsageError(`usage: ${formatUsageLine(command).trim()}`);
  }
  const method = resolveMethod(command, flags);
  rejectBodyFlags(command, flags);
  for (const query of command.query) {
    if (query.required && !present(flags[query.flag])) {
      throw new CliUsageError(`${query.flag} is required`);
    }
  }
  const headers = resolveHeaders(command, flags);
  const stdinClaimedBy =
    flags["--body-file"] === "-" ? `${command.argv.join(" ")} --body-file -` : undefined;
  checkAdminLoginUsage(flags, io.env, stdinClaimedBy);
  const requestPath = buildPath(command, positionals, flags);
  const body = await resolveBody(flags, io);
  const client = await createClient(flags, io);
  if (command.paging && flags["--all"]) {
    return runAllPages(client, command, positionals, flags, method, headers, io);
  }
  const result = await client.request(requestPath, requestInit(method, headers, body));
  writeResult(io, result);
  return 0;
}

function resolveMethod(command, flags) {
  if (command.methods.length === 1) return command.methods[0];
  const selected = String(flags["--method"] ?? command.defaultMethod).toUpperCase();
  const match = command.methods.find((method) => method === selected);
  if (!match) {
    throw new CliUsageError(`--method must be one of ${command.methods.join(", ")}`);
  }
  return match;
}

function rejectBodyFlags(command, flags) {
  const hasBody = flags["--body"] !== undefined;
  const hasFile = flags["--body-file"] !== undefined;
  if (hasBody && hasFile) throw new CliUsageError("--body and --body-file are mutually exclusive");
  if (command.body === "none" && (hasBody || hasFile)) {
    throw new CliUsageError("this command does not take a body");
  }
  if (command.body === "file" && hasBody) {
    throw new CliUsageError(
      "--body is not accepted for this command; pass --body-file so the secret stays out of shell history",
    );
  }
  if (command.body === "file" && !hasFile) throw new CliUsageError("--body-file is required");
  if (command.body === "required" && !hasBody && !hasFile) {
    throw new CliUsageError("pass --body <json> or --body-file <path>");
  }
}

function present(value) {
  return value !== undefined && value.trim() !== "";
}

function resolveHeaders(command, flags) {
  const headers = {};
  for (const header of command.headers) {
    const value = flags[header.flag];
    if (!present(value)) {
      if (header.required) throw new CliUsageError(`${header.flag} is required`);
      continue;
    }
    headers[header.header] = value;
  }
  return headers;
}

function buildPath(command, positionals, flags, cursor = flags["--cursor"]) {
  let path = command.path;
  command.params.forEach((name, index) => {
    path = path.replaceAll(`:${name}`, pathSegment(positionals[index], name));
  });
  const params = new URLSearchParams();
  for (const query of command.query) {
    if (query.name === "cursor") continue;
    if (flags[query.flag] !== undefined) params.set(query.name, flags[query.flag]);
  }
  if (cursor !== undefined) params.set("cursor", cursor);
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function resolveBody(flags, io) {
  let text;
  if (flags["--body"] !== undefined) text = flags["--body"];
  else if (flags["--body-file"] === "-") text = await readStdin(io.stdin);
  else if (flags["--body-file"] !== undefined) text = await readBodyFile(flags["--body-file"], io);
  else return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliUsageError("--body/--body-file must contain valid JSON");
  }
}

async function readBodyFile(path, io) {
  try {
    return await io.readFile(path, "utf8");
  } catch (error) {
    throw new CliUsageError(`could not read --body-file ${path}: ${error.message}`);
  }
}

function requestInit(method, headers, body) {
  return {
    method,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function runAllPages(client, command, positionals, flags, method, headers, io) {
  const { items, nextCursor } = await collectAllPages(
    (cursor) => client.request(buildPath(command, positionals, flags, cursor), { method, headers }),
    { startCursor: flags["--cursor"], resourcePath: command.path },
  );
  if (nextCursor) {
    io.stderr.write(
      `warning: --all stopped after ${MAX_ALL_PAGES} pages; more results remain (nextCursor: ${nextCursor})\n`,
    );
  }
  io.stdout.write(`${JSON.stringify({ items }, null, 2)}\n`);
  return 0;
}

function writeResult(io, result) {
  if (result !== undefined) io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
