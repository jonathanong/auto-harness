import { resolveByName } from "./resolve-by-name.js";
import { resolveRepositoryId } from "./resolve-repository.js";

async function resolveRef(ref, providers, commands) {
  if (ref == null || typeof ref !== "object") return ref;
  // Checked by value, not `in`: a name ref built by conditional spreading can carry an
  // explicit `providerId: undefined`, which `in` would treat as already resolved.
  if (ref.providerId !== undefined || ref.commandId !== undefined) return ref;
  if (ref.providerName !== undefined) {
    return { providerId: await resolveByName(ref.providerName, providers, "provider") };
  }
  if (ref.commandName !== undefined) {
    return { commandId: await resolveByName(ref.commandName, commands, "command") };
  }
  return ref;
}

/**
 * Resolves `providerName`/`commandName` entries in `input.target`/`input.fallbacks`, and
 * `input.repositoryName`, to their ids via `client.listProviders()`/`listCommands()`/
 * `listRepositories()`, each called at most once regardless of how many refs need it. Id-shaped
 * refs pass through untouched, so an all-id call makes no extra requests. Names are resolved
 * defensively against more than one match: create/update checks are read-then-write races rather
 * than atomic constraints, and legacy catalog rows are not rewritten.
 */
export async function resolveCreateSessionTargets(client, input) {
  let providersPromise;
  let commandsPromise;
  const providers = () => (providersPromise ??= client.listProviders());
  const commands = () => (commandsPromise ??= client.listCommands());

  const target = await resolveRef(input.target, providers, commands);
  const repositoryId = await resolveRepositoryId(
    client,
    input.repositoryId !== undefined
      ? input.repositoryId
      : { repositoryName: input.repositoryName },
  );
  const resolved = { ...input, repositoryId, target };
  delete resolved.repositoryName;
  if (input.fallbacks === undefined) return resolved;
  const fallbacks = await Promise.all(
    input.fallbacks.map((fallback) => resolveRef(fallback, providers, commands)),
  );
  return { ...resolved, fallbacks };
}
