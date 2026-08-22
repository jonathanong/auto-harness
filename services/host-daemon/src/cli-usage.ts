export function printUsage(log: (msg: string) => void = console.log): void {
  log(`Usage:
  auto-harness-host-daemon status [--config-only]
  auto-harness-host-daemon run-session --file session.json
  auto-harness-host-daemon start [--ws ws://host/ws]
  auto-harness-host-daemon install-service
  auto-harness-host-daemon uninstall-service

Identity (env; local defaults shown):
  HARNESS_HOST_ID   default local-1
  HARNESS_API_URL    default http://127.0.0.1:7420  (alias: HARNESS_API_HTTP)
                      On a deployed control plane this is the CloudFront WebUrl
                      from the deploy output (e.g. https://d111...cloudfront.net) —
                      never a raw API Gateway *.execute-api.*.amazonaws.com URL.
  HARNESS_API_KEY    service account token (when auth enabled)
  HARNESS_CHILD_ENV_ALLOWLIST  optional comma-separated child-process variables (non-HARNESS_)

install-service persists the daemon (systemd / LaunchAgent / logon task) from this
identity into a mode-0600 env file that is never committed. On Linux it refuses
local-1, http://127.0.0.1:7420, placeholders, and an empty HARNESS_API_KEY.

--ws overrides only the WebSocket target (REST still resolves from HARNESS_API_URL). It
accepts a raw API Gateway endpoint directly — a deploy-day escape hatch if the CloudFront
WebSocket path misbehaves — which HARNESS_API_URL does not.

Host inventory (repos, worktrees) is configured via
API/UI: PUT /api/v1/hosts/:hostId/inventory — not a local config file.

status reports local service state, this host's control-plane liveness and readiness, and
configured inventory. It exits successfully only when the service is running and the exact
host is online, non-draining, and explicitly Git-ready. Use status --config-only for the
inventory-only output. Status output never includes API keys.
`);
}
