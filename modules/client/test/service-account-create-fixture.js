/** Shared fixture for the `service-account create` test files. Deliberately not named
 * `*.test.js` — the test script globs `test/*.test.js`, and a helper matching that pattern
 * would both run as its own (empty) test file and re-run any tests defined in whichever file
 * imports it. */
export const env = { HARNESS_API_URL: "https://harness.test" };
export const THE_KEY = "ahk_live_super-secret-plaintext-key";

export function createHandler(capture) {
  return async (url, init) => {
    if (capture) capture.body = JSON.parse(init.body);
    return Response.json(
      {
        account: { id: "svc-9", kind: "service-account", name: "ci", role: "operator" },
        apiKey: THE_KEY,
      },
      { status: 201 },
    );
  };
}

export const refuseFetch = async () => {
  throw new Error("fetch must not be called");
};
