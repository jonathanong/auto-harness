import { AutoHarnessError } from "./errors.js";

function pluralize(kind) {
  return kind.endsWith("y") ? `${kind.slice(0, -1)}ies` : `${kind}s`;
}

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
      `ambiguous ${kind} name "${name}": ${matches.length} ${pluralize(kind)} share this name`,
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

async function fetchAllRepositories(client) {
  const items = [];
  let cursor;
  do {
    const page = await client.listRepositories({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

/**
 * Resolves `input.repositoryName` to `repositoryId` via `client.listRepositories()`, following
 * `nextCursor` across every page (bounded at 100 per request, the enforced max) to build the full
 * catalog before searching — unlike providers/commands, repositories are paginated rather than
 * returned as a flat array. Id-shaped input passes through untouched, so an id-only call makes no
 * requests. Repository names are server-enforced unique (`findRepositoryByName` in the API), but
 * resolved defensively against more than one match since create/update checks are read-then-write
 * races rather than atomic constraints.
 */
export async function resolveRepository(client, input) {
  // Checked by value, not `in`: a name ref built by conditional spreading can carry an explicit
  // `repositoryId: undefined`, which `in` would treat as already resolved.
  if (input.repositoryId !== undefined || input.repositoryName === undefined) return input;
  const { repositoryName, ...rest } = input;
  const resolved = await resolveByName(
    repositoryName,
    () => fetchAllRepositories(client),
    "repository",
    "repositoryId",
  );
  return { ...rest, ...resolved };
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
