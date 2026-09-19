/**
 * Resolves `--provider <id|name>` or `--command <id|name>` to a `TargetRef` for `createSession()`.
 * Exactly one of `flags["--provider"]`/`flags["--command"]` must already be set — callers
 * validate that mutual-exclusivity/required check before calling this.
 *
 * Lists the relevant catalog once (`client.listProviders()`/`listCommands()`) and checks for an
 * exact `id` match locally. A hit returns an already-id-shaped ref, which `resolveTargetSpecs`
 * (inside `client.createSession()`) passes straight through with no further request. A miss
 * returns a `providerName`/`commandName` ref instead — deliberately *not* resolved here — so
 * `createSession()`'s own `resolveCreateSessionTargets()` resolves it, reusing its exact
 * not-found/ambiguous-name errors (`UNKNOWN_PROVIDER_NAME`, `AMBIGUOUS_PROVIDER_NAME`, ...)
 * rather than reimplementing that matching. One consequence: a mistyped id surfaces as
 * `no provider named "<value>"`, not a distinct "unknown id" error.
 */
export async function resolveSessionTarget(client, flags) {
  if (flags["--provider"] !== undefined) {
    return resolveOne(
      await client.listProviders(),
      flags["--provider"],
      "providerId",
      "providerName",
    );
  }
  return resolveOne(await client.listCommands(), flags["--command"], "commandId", "commandName");
}

function resolveOne(items, value, idKey, nameKey) {
  return items.some((item) => item.id === value) ? { [idKey]: value } : { [nameKey]: value };
}
