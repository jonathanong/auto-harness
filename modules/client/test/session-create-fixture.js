/** Shared fixture for the `session create` test files (see service-account-create-fixture.js for
 * why this file is deliberately not named `*.test.js`). */
export const env = { HARNESS_API_URL: "https://harness.test" };

export const SESSION_ID = "session-1";

/**
 * Dispatches by pathname/method:
 *  - `GET /providers`, `/commands` -> `{ items: providers|commands }`
 *  - `POST /sessions` -> captures the body into `capture.body` (when given) and returns
 *    `{ id: SESSION_ID, status: "queued", ...created }`
 *  - `GET /sessions/<SESSION_ID>` -> each entry of `getResponses` in turn (the last one repeats),
 *    for `--wait` polling
 * `calls` (when given) records every request as `"<METHOD> <path>"`, in order, so a test can
 * assert exactly which/how many requests were made (e.g. no `POST .../cancel`).
 */
export function createHandler({
  providers = [],
  commands = [],
  created = {},
  getResponses = [],
  capture,
  calls,
} = {}) {
  let getCallIndex = 0;
  return async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (calls) calls.push(`${method} ${path}`);
    if (path === "/api/v1/providers") return Response.json({ items: providers });
    if (path === "/api/v1/commands") return Response.json({ items: commands });
    if (path === "/api/v1/sessions" && method === "POST") {
      if (capture) capture.body = JSON.parse(init.body);
      return Response.json({ id: SESSION_ID, status: "queued", ...created });
    }
    if (path === `/api/v1/sessions/${SESSION_ID}` && method === "GET") {
      const response = getResponses[Math.min(getCallIndex, getResponses.length - 1)];
      getCallIndex += 1;
      return Response.json(response);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
}

export const refuseFetch = async () => {
  throw new Error("fetch must not be called");
};
