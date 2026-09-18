export function usage() {
  return `auto-harness - operator CLI for the Auto Harness control plane API

Usage:
  auto-harness api <METHOD> <path> [--body <json> | --body-file <path|->]
  auto-harness whoami [--json]
  auto-harness doctor
  auto-harness help | --help | -h

Configuration:
  --api-url <url>        Control plane base URL (else HARNESS_API_URL, else HARNESS_API_HTTP)
  --api-key-file <path>  Read the API key from a file, trimmed (else HARNESS_API_KEY_FILE)
  --allow-insecure-http  Allow a plain http:// baseUrl (loopback only; local dev)

The API key is never accepted as a command-line flag: it would land in \`ps\` output and shell
history. Set the HARNESS_API_KEY environment variable, or point --api-key-file /
HARNESS_API_KEY_FILE at a file holding it.

Examples:
  auto-harness whoami
  auto-harness api GET /hosts
  auto-harness api POST /repositories --body '{"name":"org/repo","url":"https://github.com/org/repo"}'
  auto-harness api DELETE /repositories/repo-1 --body-file -
  auto-harness doctor
`;
}
