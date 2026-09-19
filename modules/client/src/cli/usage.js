export function usage() {
  return `auto-harness - operator CLI for the Auto Harness control plane API

A global flag (--api-url, --api-key-file, --allow-insecure-http, --admin-password-stdin,
--admin-username) is recognized before or after the command name — both
\`auto-harness --admin-password-stdin whoami\` and \`auto-harness whoami --admin-password-stdin\`
work the same way.

Usage:
  auto-harness api <METHOD> <path> [--body <json> | --body-file <path|->]
  auto-harness whoami [--json]
  auto-harness doctor
  auto-harness host list [--online | --offline] [--limit N] [--cursor C] [--all] [--json]
  auto-harness host drain <hostId> [--json]
  auto-harness host resume <hostId> [--json]
  auto-harness host inventory get <hostId> [--json]
  auto-harness host inventory set <hostId> --file <path|->
  auto-harness host repo add <hostId> <repositoryId> --path <path> [--worktree <id>=<path>]...
    [--default-branch <branch>] [--dry-run] [--json]
  auto-harness host repo rm <hostId> <repositoryId> [--dry-run] [--json]
  auto-harness host smoke <hostId> --repo-path <path> --provider <id|name>
    [--provider <id|name>]... [--timeout <seconds>] [--json]
  auto-harness repo add --name <name> --url <url> [--default-branch <branch>] [--json]
  auto-harness repo list [--limit N] [--cursor C] [--all] [--json]
  auto-harness repo rm <repositoryId> [--json]
  auto-harness service-account list [--limit N] [--cursor C] [--all] [--json]
  auto-harness service-account create --name <name> --role <role> [--bound-host <hostId>]
    [--repositories <id,id,...>] (--key-file <path> | --print-key) [--json]
  auto-harness service-account rm <id> [--json]
  auto-harness session create --repo <repositoryId> (--provider <id|name> | --command <id|name>) --prompt <text>
    [--timeout <seconds>] [--ref <ref>] [--concurrency-id <id>] [--wait [--wait-timeout <seconds>]] [--json]
  auto-harness session get <sessionId> [--json]
  auto-harness session logs <sessionId> [--limit N] [--cursor C] [--json]
  auto-harness session cancel <sessionId> [--json]
  auto-harness help | --help | -h

Configuration:
  --api-url <url>        Control plane base URL (else HARNESS_API_URL, else HARNESS_API_HTTP)
  --api-key-file <path>  Read the API key from a file, trimmed (else HARNESS_API_KEY_FILE)
  --allow-insecure-http  Allow a plain http:// baseUrl (loopback only; local dev)

The API key is never accepted as a command-line flag: it would land in \`ps\` output and shell
history. Set the HARNESS_API_KEY environment variable, or point --api-key-file /
HARNESS_API_KEY_FILE at a file holding it.

Admin bootstrap (no API key exists yet):
  --admin-password-stdin          Log in as an admin (password piped through stdin) instead of
                                   using an API key; combine with --admin-username (default: admin)
  --admin-username <name>         Admin username for --admin-password-stdin (default: admin)

--admin-password-stdin reads the password from stdin (one trailing newline stripped), logs in
once via POST /auth/login, and carries the session cookie on every later request instead of an
API key — it never touches argv, shell history, or output. It cannot be combined with an API key
(--api-key-file, HARNESS_API_KEY, or HARNESS_API_KEY_FILE), nor with a command that also reads
stdin for its own input (\`api --body-file -\`, \`host inventory set --file -\`).

Examples:
  auto-harness whoami
  auto-harness api GET /hosts
  auto-harness api POST /repositories --body '{"name":"org/repo","url":"https://github.com/org/repo"}'
  auto-harness api DELETE /repositories/repo-1 --body-file -
  auto-harness doctor
  auto-harness host list --online
  auto-harness host drain host-1
  auto-harness host inventory get host-1 --json > inventory.json
  auto-harness host repo add host-1 repo-1 --path /repos/repo-1
  auto-harness host repo rm host-1 repo-1 --dry-run
  auto-harness host smoke host-1 --repo-path /repos/repo-1 --provider claude
  auto-harness repo add --name org/repo --url https://github.com/org/repo
  auto-harness repo list --all
  auto-harness repo rm repo-1
  auto-harness service-account list
  auto-harness service-account create --name ci --role operator --print-key > /dev/null
  KEY=$(auto-harness service-account create --name ci --role operator --print-key)
  aws ssm get-parameter --name /auto-harness/admin-password --with-decryption \\
    --query Parameter.Value --output text \\
    | auto-harness --admin-password-stdin service-account create --name ci --role operator --print-key
  auto-harness session create --repo repo-1 --command claude-print --prompt "Review the diff" --wait
  auto-harness session get session-1
  auto-harness session logs session-1 --limit 200
  auto-harness session cancel session-1
`;
}
