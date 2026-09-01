import { type Fixture, stubGh } from "./harness-prompt-context-test-helpers.ts";

// Every pr-commits-mode test stubs the same "pr view" success and the same catch-all; only the
// "api --paginate" behavior varies per test. Centralizing that shared shape keeps each test to
// just the commits behavior it's actually exercising.
export function stubPrCommits(fx: Fixture, apiPaginateBody: string): void {
  stubGh(
    fx.bin,
    fx.callLog,
    `case "$1 $2" in
  "pr view") echo "https://github.com/example/repo/pull/42" ;;
  "api --paginate")
    ${apiPaginateBody}
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`,
  );
}

// The bot-vs-human commit tests both filter the piped commits JSON through the --jq argument
// gh api --paginate was called with; only the commits payload differs between them.
export function stubPrCommitsJq(fx: Fixture, commitsJson: string): void {
  stubPrCommits(
    fx,
    `filter=""
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == "--jq" ]]; then filter="$arg"; fi
      prev="$arg"
    done
    printf '%s' '${commitsJson}' | jq -r "$filter"`,
  );
}
