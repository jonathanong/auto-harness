import { AutoHarnessError } from "./errors.js";

async function resolveByName(name, catalog, kind, idKey) {
  const matches = (await catalog()).filter((entry) => entry.name === name);
  if (matches.length === 0) {
    throw new AutoHarnessError(`no ${kind} named "${name}"`, {
      status: 400,
      code: `UNKNOWN_${kind.toUpperCase()}_NAME`,
    });
  }
  if (matches.length > 1) {
    throw new AutoHarnessError(
      `ambiguous ${kind} name "${name}": ${matches.length} ${kind}s share this name`,
      { status: 400, code: `AMBIGUOUS_${kind.toUpperCase()}_NAME` },
    );
  }
  return { [idKey]: matches[0].id };
}

async function resolveRef(ref, providers, commands) {
  if (ref == null || typeof ref !== "object") return ref;
  // Checked by value, not `in`: a name ref built by conditional spreading can carry an
  // explicit `providerId: undefined`, which `in` would treat as already resolved.
  if (ref.providerId !== undefined || ref.commandId !== undefined) return ref;
  if (ref.providerName !== undefined) {
    return resolveByName(ref.providerName, providers, "provider", "providerId");
  }
  if (ref.commandName !== undefined) {
    return resolveByName(ref.commandName, commands, "command", "commandId");
  }
  return ref;
}

/**
 * Resolves `providerName`/`commandName` entries in `input.target`/`input.fallbacks` to
 * `providerId`/`commandId` via `client.listProviders()`/`listCommands()`, called at most once
 * each regardless of how many refs need them. Id-shaped refs pass through untouched, so an
 * all-id call makes no extra requests. Provider and command names are both resolved defensively
 * against more than one match: create/update checks are read-then-write races rather than atomic
 * constraints, and legacy catalog rows are not rewritten.
 */
export async function resolveCreateSessionTargets(client, input) {
  let providersPromise;
  let commandsPromise;
  const providers = () => (providersPromise ??= client.listProviders());
  const commands = () => (commandsPromise ??= client.listCommands());

  const target = await resolveRef(input.target, providers, commands);
  if (input.fallbacks === undefined) return { ...input, target };
  const fallbacks = await Promise.all(
    input.fallbacks.map((fallback) => resolveRef(fallback, providers, commands)),
  );
  return { ...input, target, fallbacks };
}
