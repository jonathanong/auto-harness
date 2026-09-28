/** Shared fixture for the `host smoke` test files — deliberately not named `*.test.js` (see
 * `host-repo-rm-fixture.js`'s own comment for why). */

export const HOST_ID = "host-1";
export const REPOSITORY_ID = "repo-1";
export const REPO_PATH = "/repos/x";
export const PROVIDER = "claude";
export const env = { HARNESS_API_URL: "https://harness.test" };

export const BASE_ARGV = [
  "host",
  "smoke",
  HOST_ID,
  "--repository-id",
  REPOSITORY_ID,
  "--repo-path",
  REPO_PATH,
  "--provider",
  PROVIDER,
];

const MARKER_RE = /Reply with exactly: (\S+)$/;

/**
 * Builds a fetch router with a preconfigured repository and host attachment, plus one
 * `completed`/`exitCode: 0` session whose stdout echoes the prompt marker. Every request
 * is recorded into `calls` as `"<METHOD> <path>"`; `state` exposes what actually happened
 * (session records by id, cancelled session ids, current inventory) for
 * assertions. `sessionStatuses(id, [...])` (below) is the usual way to script a `GET
 * /sessions/<id>` sequence; `overrides.getSession(id, session, callIndex)` is the general escape
 * hatch when a test needs something a status list can't express (e.g. `errorCode`).
 */
export function makeSmokeFetch(overrides = {}) {
  const calls = [];
  const inventory = {
    version: 1,
    repositories: [
      {
        id: REPOSITORY_ID,
        path: REPO_PATH,
        defaultBranch: "main",
        worktrees: [
          {
            id: "smoke-ready",
            name: "smoke-ready",
            path: `${REPO_PATH}/.worktrees/smoke-ready`,
            labels: [],
          },
        ],
      },
    ],
    providerAccounts: [{ providerAccountId: "acct-1" }],
  };
  const sessionGetCounts = new Map();
  const state = {
    calls,
    cancelledSessionIds: [],
    sessions: new Map(),
    get inventory() {
      return inventory;
    },
  };

  const providers = overrides.providers ?? [{ id: "prov-1", name: PROVIDER }];

  async function handleGetRepository() {
    if (overrides.getRepository) return overrides.getRepository();
    return Response.json({ id: REPOSITORY_ID, name: "policy-smoke", defaultBranch: "main" });
  }

  async function handleInventoryGet() {
    if (overrides.getInventory) return overrides.getInventory(inventory);
    return Response.json(inventory);
  }

  async function handleCreateSession(init) {
    const body = JSON.parse(init.body);
    if (overrides.createSession) return overrides.createSession(body);
    const id = `session-${state.sessions.size + 1}`;
    const marker = body.prompt.match(MARKER_RE)?.[1];
    const session = { id, status: "queued", target: body.target, marker };
    state.sessions.set(id, session);
    return Response.json({ id, status: "queued" });
  }

  async function handleGetSession(sessionId) {
    const session = state.sessions.get(sessionId);
    const callIndex = sessionGetCounts.get(sessionId) ?? 0;
    sessionGetCounts.set(sessionId, callIndex + 1);
    if (overrides.getSession) return overrides.getSession(sessionId, session, callIndex);
    return Response.json({ id: sessionId, status: "completed", exitCode: 0 });
  }

  async function handleCancelSession(sessionId) {
    state.cancelledSessionIds.push(sessionId);
    if (overrides.cancelSession) return overrides.cancelSession(sessionId);
    return Response.json({ id: sessionId, status: "cancelled" });
  }

  async function handleLogs(sessionId) {
    if (overrides.logsFor) return overrides.logsFor(sessionId);
    const session = state.sessions.get(sessionId);
    const content = session?.marker ? `Reply with exactly: ${session.marker}` : "";
    return Response.json({
      items: [{ stream: "stdout", content, timestamp: "2026-01-01T00:00:00Z" }],
    });
  }

  const fetch = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname === `/api/v1/repositories/${REPOSITORY_ID}` && method === "GET")
      return handleGetRepository();
    if (u.pathname === "/api/v1/providers") return Response.json({ items: providers });
    if (u.pathname === `/api/v1/hosts/${HOST_ID}/inventory` && method === "GET")
      return handleInventoryGet();
    if (u.pathname === "/api/v1/sessions" && method === "POST") return handleCreateSession(init);
    const cancelMatch = /^\/api\/v1\/sessions\/([^/]+)\/cancel$/.exec(u.pathname);
    if (cancelMatch && method === "POST") return handleCancelSession(cancelMatch[1]);
    const logsMatch = /^\/api\/v1\/sessions\/([^/]+)\/logs$/.exec(u.pathname);
    if (logsMatch) return handleLogs(logsMatch[1]);
    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(u.pathname);
    if (sessionMatch && method === "GET") return handleGetSession(sessionMatch[1]);
    throw new Error(`unexpected request in host smoke fixture: ${method} ${u.pathname}`);
  };

  return { fetch, calls, state };
}

/** Scripts a `GET /sessions/<id>` sequence for `overrides.getSession`: each entry of `statuses`
 * in turn (the last repeats), merged onto `{ id, status }`. */
export function sessionStatuses(statuses) {
  return (sessionId, _session, callIndex) => {
    const entry = statuses[Math.min(callIndex, statuses.length - 1)];
    return Response.json({ id: sessionId, ...entry });
  };
}

/** A fake clock pair, like `wait-for-session.test.js`'s own `fakeClock()` — `sleep(ms)`
 * advances the virtual clock instantly instead of really waiting, so a `--timeout` test
 * resolves synchronously regardless of the seconds it names. */
export function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}
