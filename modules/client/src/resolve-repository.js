import { resolveByName } from "./resolve-by-name.js";

async function listAllRepositories(client) {
  const items = [];
  let page = await client.listRepositories();
  items.push(...page.items);
  while (page.nextCursor) {
    page = await client.listRepositories({ cursor: page.nextCursor });
    items.push(...page.items);
  }
  return items;
}

/**
 * Resolves a `repositoryId` string or a `RepositoryRef` to a `repositoryId`. Unlike providers and
 * commands, repositories are not exposed as a single unpaginated catalog call, so resolving by
 * `repositoryName` pages through `listRepositories()` in full before matching.
 */
export async function resolveRepositoryId(client, ref) {
  if (typeof ref === "string") return ref;
  if (ref.repositoryId !== undefined) return ref.repositoryId;
  return resolveByName(ref.repositoryName, () => listAllRepositories(client), "repository");
}
