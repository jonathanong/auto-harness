import { manifestCommandCatalog } from "./management-command-catalog.js";
import { manifestCommandData } from "./management-command-data.js";

function covered(id, method, path, via) {
  return {
    id,
    methods: [method],
    defaultMethod: method,
    path,
    via,
    params: [],
    query: [],
    paging: false,
    body: "none",
    headers: [],
  };
}

/** Rich commands and the login/health probes. The runner does not execute `via` rows. */
const builtinCoverage = [
  covered("auth.login", "POST", "/auth/login", "admin-login.js"),
  covered("auth.me", "GET", "/auth/me", "whoami.js"),
  covered("health", "GET", "/health", "doctor.js"),
  covered("host.list", "GET", "/hosts", "host-list.js"),
  covered("host.drain", "POST", "/hosts/drain", "host-drain.js"),
  covered("host.resume", "POST", "/hosts/resume", "host-resume.js"),
  covered("host.inventory.get", "GET", "/hosts/:hostId/inventory", "host-inventory-get.js"),
  covered("host.inventory.set", "PUT", "/hosts/:hostId/inventory", "host-inventory-set.js"),
  covered("repo.add", "POST", "/repositories", "repo-add.js"),
  covered("repo.list", "GET", "/repositories", "repo-list.js"),
  covered("repo.rm", "DELETE", "/repositories/:repositoryId", "repo-rm.js"),
  covered("service-account.list", "GET", "/auth/service-accounts", "service-account-list.js"),
  covered("service-account.create", "POST", "/auth/service-accounts", "service-account-create.js"),
  covered(
    "service-account.rm",
    "DELETE",
    "/auth/service-accounts/:serviceAccountId",
    "service-account-rm.js",
  ),
  covered("session.create", "POST", "/sessions", "session-create.js"),
  covered("session.get", "GET", "/sessions/:sessionId", "session-get.js"),
  covered("session.logs", "GET", "/sessions/:sessionId/logs", "session-logs.js"),
  covered("session.cancel", "POST", "/sessions/:sessionId/cancel", "session-cancel.js"),
];

export const managementCommands = [
  ...builtinCoverage,
  ...manifestCommandData,
  ...manifestCommandCatalog,
];

export function formatUsageLine(command) {
  const parts = [`auto-harness ${command.argv.join(" ")}`];
  if (command.params.length > 0) {
    parts.push(command.params.map((name) => `<${name}>`).join(" "));
  }
  if (command.methods.length > 1) parts.push("[--method put|patch]");
  for (const query of command.query) {
    const text = `${query.flag} <value>`;
    parts.push(query.required ? text : `[${text}]`);
  }
  if (command.paging) parts.push("[--all]");
  if (command.body === "optional") parts.push("[--body <json> | --body-file <path|->]");
  if (command.body === "required") parts.push("(--body <json> | --body-file <path|->)");
  if (command.body === "file") parts.push("--body-file <path|->");
  for (const header of command.headers) {
    const text = `${header.flag} <value>`;
    parts.push(header.required ? text : `[${text}]`);
  }
  return `  ${parts.join(" ")}`;
}

export function manifestUsageLines() {
  return managementCommands
    .filter((command) => command.argv && !command.via)
    .map(formatUsageLine)
    .toSorted();
}

export function usageUnder(prefix) {
  return managementCommands
    .filter(
      (command) =>
        command.argv && !command.via && prefix.every((part, index) => command.argv[index] === part),
    )
    .map(formatUsageLine);
}
