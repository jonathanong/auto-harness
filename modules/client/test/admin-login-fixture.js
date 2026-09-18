/** Shared fixture for the `--admin-password-stdin` test files. Deliberately not named
 * `*.test.js` — the test script globs `test/*.test.js`, and a helper matching that pattern
 * would both run as its own (empty) test file and re-run any tests defined in whichever file
 * imports it. */
export const env = { HARNESS_API_URL: "https://harness.test" };
export const COOKIE_A = "ah_session=abc123";
export const COOKIE_B = "ah_csrf=def456";

export function loginResponse(status, { cookies = [] } = {}) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  // A unique marker in the login response body: proves the body is never read/printed.
  const body = JSON.stringify({ principal: { marker: "LOGIN_BODY_MARKER_DO_NOT_PRINT" } });
  return new Response(body, { status, headers });
}

export const refuseFetch = async () => {
  throw new Error("fetch must not be called");
};
