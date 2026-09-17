import { createHmac } from "node:crypto";

import { hasValidSession } from "@auto-harness/shared";
import { describe, expect, it, vi } from "vitest";

import { config } from "../test-helpers/deployment-test-helpers.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";
import {
  mintAdminSessionToken,
  probeAuthenticatedDeployment,
} from "./deploy-authenticated-smoke.ts";

const testConfig = config();
const secret = "s3cret-session-signing-value-32chars!!";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const adminsB64 = b64([{ username: "root-admin", password: "correct-horse" }]);
// The realistic case: every AWS deploy hardcodes HARNESS_AUTH_MODE=required in the deployed
// Lambdas, but the deploy script's own process env does not set it -- so unset must proceed.
const env = {} as NodeJS.ProcessEnv;
/** A compact JWT: three base64url segments. See the leak assertions at the end of the file. */
const COMPACT_JWT = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u;

/**
 * A local fetch/query/log/run stub built for this file only -- deployment-test-helpers.ts's
 * shared `dependencies()` fetch stub is being changed by another in-flight PR, so this test
 * intentionally does not depend on it.
 */
function makeDeps(options: {
  admins?: string | null;
  secretParam?: string | null;
  fetchResponses: Array<() => Response>;
}): DeploymentDependencies & { log: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> } {
  const responses = [...options.fetchResponses];
  return {
    log: vi.fn(),
    query: vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("get-parameter")) {
        const name = args[args.indexOf("--name") + 1];
        if (name === testConfig.adminsSsmParam) {
          return options.admins == null
            ? { status: 254, stderr: "ParameterNotFound", stdout: "" }
            : { status: 0, stderr: "", stdout: `${options.admins}\n` };
        }
        if (name === testConfig.sessionSecretSsmParam) {
          return options.secretParam == null
            ? { status: 254, stderr: "ParameterNotFound", stdout: "" }
            : { status: 0, stderr: "", stdout: `${options.secretParam}\n` };
        }
      }
      throw new Error(`unexpected query: ${args.join(" ")}`);
    }),
    run: vi.fn(async () => {}),
    fetch: vi.fn(async () => {
      const factory = responses.shift();
      if (!factory) throw new Error("unexpected extra fetch call");
      return factory();
    }),
  };
}

function authedDeps(fetchResponses: Array<() => Response>) {
  return makeDeps({ admins: adminsB64, secretParam: secret, fetchResponses });
}

const okHostsPage = () =>
  new Response('<div data-pw="page-hosts"><h2 data-pw="hosts-heading">Hosts</h2></div>', {
    status: 200,
  });
const okHostsApi = () => Response.json({ items: [] });
const notFoundWrite = () =>
  Response.json({ error: { code: "NOT_FOUND", message: "resource not found" } }, { status: 404 });
const forbiddenWrite = () =>
  Response.json(
    { error: { code: "FORBIDDEN", message: "insufficient role for this operation" } },
    { status: 403 },
  );
const badGateway = () => new Response("boom", { status: 502 });
const emptyPage = () => new Response("<html></html>");
// dependencies.fetch is called with redirect: "manual", so a rejected session shows up as
// the real 307 status, not a followed redirect -- see the comment on the source check.
const redirectedToLogin = () => new Response(null, { status: 307 });
const digestLeakPage = () =>
  new Response('<div data-pw="page-hosts">NEXT_REDIRECT;replace;/login;307;</div>');
const hostsApi500 = () => new Response("boom", { status: 500 });
const hostsApiNoItems = () => Response.json({ ok: true });
const wrongEnvelopeWrite = () =>
  Response.json({ error: { code: "SOMETHING_ELSE" } }, { status: 404 });
const decodePayload = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

describe("mintAdminSessionToken", () => {
  it("mints a token hasValidSession accepts, matching the real admin id shape", async () => {
    const token = mintAdminSessionToken("root-admin", secret, () => 1_800_000_000_000);
    expect(await hasValidSession(token, secret)).toBe(true);
    expect(decodePayload(token)).toEqual({
      id: "admin:root-admin",
      username: "root-admin",
      role: "admin",
      kind: "admin",
      exp: 1_800_000_120,
    });
  });

  it("rejects once expired", async () => {
    const expired = mintAdminSessionToken("root-admin", secret, () => Date.now() - 10 * 60 * 1000);
    expect(await hasValidSession(expired, secret)).toBe(false);
  });

  // hasValidSession only checks header/claims shape, not samePrincipalClaims (services/api/src/auth.ts,
  // needs a live AuthService) -- this documents why the mint path must never add a claim, not
  // that auth.ts's stricter server-side check also runs here.
  it("rejects a token carrying a claim outside the allowed set", async () => {
    const token = mintAdminSessionToken("root-admin", secret, () => Date.now());
    const payload = decodePayload(token);
    const tampered = { ...payload, extra: "nope" };
    const unsigned = `${token.split(".")[0]}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}`;
    const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
    expect(await hasValidSession(`${unsigned}.${signature}`, secret)).toBe(true);
    expect(Object.keys(payload).toSorted()).toEqual(["exp", "id", "kind", "role", "username"]);
  });
});

describe("probeAuthenticatedDeployment", () => {
  it("skips with a log line when HARNESS_AUTH_MODE is explicitly not required", async () => {
    const deps = makeDeps({ fetchResponses: [] });
    await probeAuthenticatedDeployment(testConfig, deps, "https://web.example.test", {
      HARNESS_AUTH_MODE: "disabled",
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("HARNESS_AUTH_MODE"));
  });

  // Unset matches every real AWS deploy (see the module doc comment); explicit "required"
  // must behave identically.
  it.each([{}, { HARNESS_AUTH_MODE: "required" } as NodeJS.ProcessEnv])(
    "proceeds and probes when auth mode env is %j",
    async (envValue) => {
      const deps = authedDeps([okHostsPage, okHostsApi, notFoundWrite]);
      await probeAuthenticatedDeployment(testConfig, deps, "https://web.example.test", envValue);
      expect(deps.fetch).toHaveBeenCalledTimes(3);
    },
  );

  // Each covers a distinct branch: absent (null), empty value, invalid JSON, non-array,
  // empty array, non-object first entry, null first entry, missing/empty username.
  const badAdmins: Array<string | null> = [
    null,
    "",
    "not-valid-base64-json",
    b64({ username: "x" }),
    b64([]),
    b64([42]),
    b64([null]),
    b64([{ password: "x" }]),
    b64([{ username: "", password: "x" }]),
  ];
  it.each(badAdmins)("skips when the admins value is %j", async (admins) => {
    const deps = makeDeps({ admins, fetchResponses: [] });
    await probeAuthenticatedDeployment(testConfig, deps, "https://web.example.test", env);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("no usable admin"));
  });

  it("skips with a log line when the session secret parameter is unreadable", async () => {
    const deps = makeDeps({ admins: adminsB64, secretParam: null, fetchResponses: [] });
    await probeAuthenticatedDeployment(testConfig, deps, "https://web.example.test", env);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("harness-session-secret"));
  });

  it("passes the happy path and probes all three authenticated surfaces", async () => {
    const deps = authedDeps([okHostsPage, okHostsApi, notFoundWrite]);
    await probeAuthenticatedDeployment(testConfig, deps, "https://web.example.test", env);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("Authenticated smoke probes passed"),
    );
  });

  // One case per guard the module throws on, each proven a real guard by mutation testing
  // (see the PR description): breaking the corresponding `if` in the source makes exactly
  // this case fail, nothing else. The expected substring doubles as the case label.
  const failureCases: Array<[Array<() => Response>, string]> = [
    [[badGateway], "check failed with HTTP 502"],
    [[emptyPage], "did not render its page-hosts content marker"],
    [[redirectedToLogin], "redirected (HTTP 307) instead of rendering"],
    [[digestLeakPage], "leaked a Next.js control-flow digest"],
    [[okHostsPage, hostsApi500], "GET /api/v1/hosts failed with HTTP 500"],
    [[okHostsPage, hostsApiNoItems], "returned a 200 without an items array"],
    [[okHostsPage, okHostsApi, forbiddenWrite], "unrouted write returned HTTP 403, expected 404"],
    [[okHostsPage, okHostsApi, wrongEnvelopeWrite], "did not carry a NOT_FOUND envelope"],
  ];
  it.each(failureCases)("fails with %s", async (responses, expected) => {
    const deps = authedDeps(responses);
    await expect(
      probeAuthenticatedDeployment(testConfig, deps, "https://web.example.test", env),
    ).rejects.toThrow(expected);
  });

  it("never logs the secret, the admin password, or the minted token", async () => {
    const cases = [
      makeDeps({ fetchResponses: [] }),
      makeDeps({ admins: null, fetchResponses: [] }),
      authedDeps([okHostsPage, okHostsApi, notFoundWrite]),
      authedDeps([() => new Response("<html></html>", { status: 200 })]),
    ];
    for (const deps of cases) {
      const outcome = probeAuthenticatedDeployment(
        testConfig,
        deps,
        "https://web.example.test",
        env,
      );
      const thrownMessage = await outcome.then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const loggedText = deps.log.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      // Plain-text leaks: the signing secret and the admin password are never encoded, so
      // their literal presence in a log line or thrown Error is a leak.
      for (const forbidden of [secret, "correct-horse", "admin:root-admin"]) {
        expect(loggedText).not.toContain(forbidden);
        expect(thrownMessage).not.toContain(forbidden);
      }
      // The token itself is base64url-encoded, so NONE of the claims above appear in it
      // literally -- a fully leaked session token would sail past the loop. Assert its shape
      // instead: three long base64url segments is a session cookie in a log, whatever it
      // encodes. The 20-char floor is well under a real JWT's segments (header ~36, payload
      // ~110, signature 43) and well over any dotted hostname or SSM path we do log.
      expect(loggedText).not.toMatch(COMPACT_JWT);
      expect(thrownMessage).not.toMatch(COMPACT_JWT);
    }
  });
});
