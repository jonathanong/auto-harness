import { IF_MATCH, cmd, paged, q } from "./management-command-define.js";

/** Catalogs, schedules, pools, integrations, and operator reads. */
export const manifestCommandCatalog = [
  cmd(["provider", "list"], "GET", "/providers", paged()),
  cmd(["provider", "get"], "GET", "/providers/:providerId", { params: ["providerId"] }),
  cmd(["provider", "create"], "POST", "/providers", { body: "required" }),
  cmd(["provider", "update"], ["PUT", "PATCH"], "/providers/:providerId", {
    params: ["providerId"],
    body: "required",
  }),
  cmd(["provider", "rm"], "DELETE", "/providers/:providerId", { params: ["providerId"] }),

  cmd(["command", "list"], "GET", "/commands", paged()),
  cmd(["command", "get"], "GET", "/commands/:commandId", { params: ["commandId"] }),
  cmd(["command", "create"], "POST", "/commands", { body: "required" }),
  cmd(["command", "update"], ["PUT", "PATCH"], "/commands/:commandId", {
    params: ["commandId"],
    body: "required",
  }),
  cmd(["command", "rm"], "DELETE", "/commands/:commandId", { params: ["commandId"] }),

  cmd(["provider-account", "list"], "GET", "/provider-accounts", paged()),
  cmd(["provider-account", "get"], "GET", "/provider-accounts/:providerAccountId", {
    params: ["providerAccountId"],
  }),
  cmd(["provider-account", "create"], "POST", "/provider-accounts", { body: "required" }),
  cmd(["provider-account", "update"], ["PUT", "PATCH"], "/provider-accounts/:providerAccountId", {
    params: ["providerAccountId"],
    body: "required",
  }),
  cmd(["provider-account", "rm"], "DELETE", "/provider-accounts/:providerAccountId", {
    params: ["providerAccountId"],
  }),
  cmd(
    ["provider-account", "usage-limit", "clear"],
    "DELETE",
    "/provider-accounts/:providerAccountId/usage-limit",
    { params: ["providerAccountId"] },
  ),
  cmd(["provider-account", "leases"], "GET", "/provider-accounts/:providerAccountId/leases", {
    params: ["providerAccountId"],
    ...paged(),
  }),
  cmd(
    ["provider-account", "lease", "release"],
    "POST",
    "/provider-accounts/:providerAccountId/leases/:slot/release",
    { params: ["providerAccountId", "slot"] },
  ),

  cmd(["schedule", "list"], "GET", "/schedules", paged()),
  cmd(["schedule", "get"], "GET", "/schedules/:scheduleId", { params: ["scheduleId"] }),
  cmd(["schedule", "create"], "POST", "/schedules", { body: "required" }),
  cmd(["schedule", "update"], ["PUT", "PATCH"], "/schedules/:scheduleId", {
    params: ["scheduleId"],
    body: "required",
  }),
  cmd(["schedule", "rm"], "DELETE", "/schedules/:scheduleId", { params: ["scheduleId"] }),
  cmd(["schedule", "trigger"], "POST", "/schedules/:scheduleId/trigger", {
    params: ["scheduleId"],
  }),

  cmd(
    ["worktree", "list"],
    "GET",
    "/worktrees",
    paged([q("--host-id", "hostId"), q("--repository-id", "repositoryId")]),
  ),
  cmd(["worktree", "get"], "GET", "/worktrees/:worktreeId", { params: ["worktreeId"] }),

  cmd(["workspace-pool", "list"], "GET", "/workspace-pools"),
  cmd(["workspace-pool", "get"], "GET", "/workspace-pools/:workspacePoolId", {
    params: ["workspacePoolId"],
  }),
  cmd(["workspace-pool", "create"], "POST", "/workspace-pools", { body: "required" }),
  cmd(["workspace-pool", "update"], ["PUT", "PATCH"], "/workspace-pools/:workspacePoolId", {
    params: ["workspacePoolId"],
    body: "required",
  }),
  cmd(["workspace-pool", "rm"], "DELETE", "/workspace-pools/:workspacePoolId", {
    params: ["workspacePoolId"],
  }),
  cmd(
    ["workspace-pool", "exec-config", "get"],
    "GET",
    "/workspace-pools/:workspacePoolId/exec-config",
    { params: ["workspacePoolId"] },
  ),

  cmd(["integration", "slack", "get"], "GET", "/integrations/slack"),
  cmd(["integration", "slack", "create"], "POST", "/integrations/slack", { body: "required" }),
  cmd(["integration", "slack", "replace"], "PUT", "/integrations/slack", { body: "required" }),
  cmd(["integration", "slack", "patch"], "PATCH", "/integrations/slack", { body: "required" }),
  cmd(["integration", "slack", "rm"], "DELETE", "/integrations/slack"),
  cmd(["integration", "slack", "oauth-start"], "POST", "/integrations/slack/oauth/start", {
    body: "required",
  }),
  cmd(["integration", "github", "get"], "GET", "/integrations/github-ingress"),
  cmd(["integration", "github", "create"], "POST", "/integrations/github-ingress", {
    body: "required",
  }),
  cmd(["integration", "github", "update"], "PUT", "/integrations/github-ingress", {
    body: "required",
  }),
  cmd(["integration", "github", "rm"], "DELETE", "/integrations/github-ingress", {
    headers: IF_MATCH,
  }),
  cmd(["integration", "custom", "get"], "GET", "/integrations/custom/:integrationId", {
    params: ["integrationId"],
  }),
  cmd(["integration", "custom", "create"], "POST", "/integrations/custom/:integrationId", {
    params: ["integrationId"],
    body: "required",
  }),
  cmd(["integration", "custom", "update"], "PUT", "/integrations/custom/:integrationId", {
    params: ["integrationId"],
    body: "required",
  }),
  cmd(["integration", "custom", "rm"], "DELETE", "/integrations/custom/:integrationId", {
    params: ["integrationId"],
    headers: IF_MATCH,
  }),

  cmd(["settings", "session-logs", "get"], "GET", "/session-log-settings"),
  cmd(["settings", "session-logs", "set"], "PUT", "/session-log-settings", { body: "required" }),
  cmd(
    ["audit-log", "list"],
    "GET",
    "/audit-logs",
    paged([
      q("--actor-id", "actorId"),
      q("--action", "action"),
      q("--resource-type", "resourceType"),
      q("--resource-id", "resourceId"),
      q("--repository-id", "repositoryId"),
      q("--outcome", "outcome"),
    ]),
  ),
  cmd(["user-session", "list"], "GET", "/user-sessions", paged()),
  cmd(["session-target", "list"], "GET", "/session-targets", paged()),
  cmd(["usage", "list"], "GET", "/usage", {
    query: [
      q("--repository-id", "repositoryId", true),
      q("--provider-id", "providerId"),
      q("--provider-account-id", "providerAccountId"),
      q("--command-id", "commandId"),
    ],
  }),
];
