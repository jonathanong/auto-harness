/** Shared fixture for the `host repo add` test files. Deliberately not named `*.test.js` — see
 * `host-repo-rm-fixture.js`'s own comment for why. */

/** The `GET /repositories/<id>` record `host repo add` fetches to resolve the entry's
 * `defaultBranch` fallback and to fail fast on an unknown id. */
export function repositoryRecord(overrides) {
  return {
    id: "repo-c",
    name: "org/repo-c",
    url: "https://x",
    defaultBranch: "main",
    ...overrides,
  };
}

/** Routes GET /repositories/<id> and GET/PUT /hosts/<id>/inventory to separate handlers, so
 * each test only has to describe the one leg it cares about. A PUT only ever targets the
 * inventory route, so checking the method first is enough to disambiguate. */
export function fetchFor({ repository, onGetInventory, onPut }) {
  return async (url, init) => {
    if (init?.method === "PUT") return onPut(url, init);
    if (/\/repositories\/[^/]+$/.test(url)) {
      return repository instanceof Response ? repository : Response.json(repository);
    }
    return onGetInventory(url, init);
  };
}
