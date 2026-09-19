/** One progress line per step, as it happens — always stderr, so stdout stays a clean final
 * summary (mirrors `session create --wait`'s status-change lines going to stderr). */
export function step(io, ok, message) {
  io.stderr.write(`${ok ? "ok" : "FAIL"}  ${message}\n`);
}

/**
 * The clean final summary on stdout: `--json` prints the full structured `result` verbatim;
 * otherwise one `PASS`/`FAIL` line per provider (only ever empty when repo create/attach itself
 * failed, in which case `result.setupError` is printed instead), then one overall line.
 */
export function printSummary(io, flags, result) {
  if (flags["--json"]) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.setupError) {
    io.stdout.write(`FAIL  setup: ${result.setupError}\n`);
  }
  for (const provider of result.providers) {
    const detail = provider.message ? `: ${provider.message}` : "";
    io.stdout.write(`${provider.pass ? "PASS" : "FAIL"}  ${provider.provider}${detail}\n`);
  }
  const passed = result.providers.filter((provider) => provider.pass).length;
  if (result.providers.length > 0) {
    io.stdout.write(`${passed}/${result.providers.length} providers passed\n`);
  }
  io.stdout.write(`teardown ${result.teardown.ok ? "ok" : "FAILED"}\n`);
  io.stdout.write(`host smoke ${result.ok ? "PASSED" : "FAILED"} for host ${result.hostId}\n`);
}
