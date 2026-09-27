import { IDEMPOTENCY, cmd, paged, q } from "./management-command-define.js";

const sessionList = paged([
  q("--status", "status"),
  q("--repository-id", "repositoryId"),
  q("--host-id", "hostId"),
  q("--source", "source"),
  q("--sort", "sort"),
  q("--concurrency-id", "concurrencyId"),
  q("--schedule-id", "scheduleId"),
]);

/** Sessions, repositories, accounts, and hosts. */
export const manifestCommandData = [
  cmd(["account", "password"], "PUT", "/auth/password", { body: "file" }),
  cmd(["user", "list"], "GET", "/auth/users", paged()),
  cmd(["user", "create"], "POST", "/auth/users", { body: "file" }),
  cmd(["user", "rm"], "DELETE", "/auth/users/:username", { params: ["username"] }),

  cmd(["repo", "get"], "GET", "/repositories/:repositoryId", { params: ["repositoryId"] }),
  cmd(["repo", "update"], ["PUT", "PATCH"], "/repositories/:repositoryId", {
    params: ["repositoryId"],
    body: "required",
  }),
  cmd(["repo", "pause"], "POST", "/repositories/:repositoryId/pause", {
    params: ["repositoryId"],
  }),
  cmd(["repo", "drain"], "POST", "/repositories/:repositoryId/drain", {
    params: ["repositoryId"],
  }),
  cmd(["repo", "activate"], "POST", "/repositories/:repositoryId/activate", {
    params: ["repositoryId"],
  }),
  cmd(["repo", "session-drain", "start"], "POST", "/repositories/:repositoryId/session-drains", {
    params: ["repositoryId"],
    headers: IDEMPOTENCY,
  }),
  cmd(
    ["repo", "session-drain", "get"],
    "GET",
    "/repositories/:repositoryId/session-drains/:operationId",
    { params: ["repositoryId", "operationId"] },
  ),
  cmd(
    ["repo", "session-drain", "release"],
    "POST",
    "/repositories/:repositoryId/session-drains/:operationId/release",
    { params: ["repositoryId", "operationId"] },
  ),

  cmd(["session", "list"], "GET", "/sessions", sessionList),
  cmd(["session", "resume"], "POST", "/sessions/:sessionId/resume", {
    params: ["sessionId"],
    body: "optional",
  }),
  cmd(["session", "clone"], "POST", "/sessions/:sessionId/clone", {
    params: ["sessionId"],
    body: "optional",
  }),
  cmd(["session", "archive"], "POST", "/sessions/:sessionId/archive", { params: ["sessionId"] }),
  cmd(["session", "archive", "get"], "GET", "/sessions/:sessionId/archive", {
    params: ["sessionId"],
  }),
  cmd(["session", "children", "list"], "GET", "/sessions/:sessionId/children", {
    params: ["sessionId"],
    ...paged(),
  }),
  cmd(["session", "children", "create"], "POST", "/sessions/:sessionId/children", {
    params: ["sessionId"],
    body: "required",
  }),
  cmd(["session", "usage"], "GET", "/sessions/:sessionId/usage", { params: ["sessionId"] }),
  cmd(["session", "prior-context"], "GET", "/sessions/:sessionId/prior-context", {
    params: ["sessionId"],
  }),

  cmd(["host", "get"], "GET", "/hosts/:hostId", { params: ["hostId"] }),
  cmd(["host", "inventory", "list"], "GET", "/host-inventories", paged()),
  cmd(["host", "inventory", "rm"], "DELETE", "/hosts/:hostId/inventory", { params: ["hostId"] }),
  cmd(["host", "exec-config", "set"], "PUT", "/hosts/:hostId/exec-config", {
    params: ["hostId"],
    body: "required",
  }),
  cmd(["host", "update-config", "get"], "GET", "/hosts/:hostId/update-config", {
    params: ["hostId"],
  }),
  cmd(["host", "update-config", "set"], "PUT", "/hosts/:hostId/update-config", {
    params: ["hostId"],
    body: "required",
  }),
];
