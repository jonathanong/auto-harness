// The real npm-published vouchington-tooling@0.4.1 scripts/gha/write-github-multiline-output.sh,
// exercised in place so the createRequire resolution fix is verified end to end.
export const WRITE_MULTILINE_OUTPUT_SH = `#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-name>" >&2
  exit 2
fi

output_name=$1
if [[ ! "$output_name" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "invalid GitHub output name: $output_name" >&2
  exit 2
fi

if [[ -z "\${GITHUB_OUTPUT:-}" ]]; then
  echo 'GITHUB_OUTPUT must be set' >&2
  exit 2
fi

temporary_root=\${RUNNER_TEMP:-\${TMPDIR:-/tmp}}
payload_file=$(mktemp "$temporary_root/write-github-multiline-output.XXXXXX")
trap 'rm -f "$payload_file"' EXIT HUP INT TERM
cat >"$payload_file"

delimiter_prefix=$(printf '%s' "$output_name" | tr '[:lower:]-' '[:upper:]_')
delimiter=''
attempt=1
while [[ $attempt -le 10 ]]; do
  if ! uuid=$(uuidgen); then
    echo 'uuidgen failed while creating a GitHub output delimiter' >&2
    exit 1
  fi
  if [[ -z "$uuid" ]]; then
    echo 'uuidgen returned an empty GitHub output delimiter suffix' >&2
    exit 1
  fi

  normalized_uuid=$(printf '%s' "$uuid" | tr '[:lower:]-' '[:upper:]_')
  delimiter="\${delimiter_prefix}_\${normalized_uuid}"
  if ! grep -Fq -- "$delimiter" "$payload_file"; then
    break
  fi

  delimiter=''
  attempt=$((attempt + 1))
done

if [[ -z "$delimiter" ]]; then
  echo 'could not create a collision-free GitHub output delimiter after 10 attempts' >&2
  exit 1
fi

{
  printf '%s<<%s\\n' "$output_name" "$delimiter"
  cat "$payload_file"
  if [[ -s "$payload_file" ]] && [[ $(tail -c 1 "$payload_file" | wc -l | tr -d ' ') -eq 0 ]]; then
    printf '\\n'
  fi
  printf '%s\\n' "$delimiter"
} >>"$GITHUB_OUTPUT"
`;
