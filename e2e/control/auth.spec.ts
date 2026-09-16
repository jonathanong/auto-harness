import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";
import { API_BASE, CONTROL_PORT } from "../harness-endpoints.ts";
import { expectNoLeakedNextDigest } from "../no-redirect-leak.ts";

const apiUrl = `${API_BASE}/api/v1`;
const controlOrigin = `http://127.0.0.1:${CONTROL_PORT}`;
const admin = { username: "auth-admin", password: "auth-password" };
const sessionSecret = "auth-e2e-session-secret-auth-e2e-session-secret";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test.describe("control plane required authentication", () => {
  test.skip(process.env.HARNESS_E2E_AUTH !== "1", "requires the dedicated required-auth E2E stack");

  test("login, safe return, password change, logout, and expiry redirect", async ({
    page,
    request,
  }) => {
    const username = `pw-auth-${test.info().parallelIndex}-${Date.now()}`;
    const password = "before-password";
    const nextPassword = "after-password";
    const basic = Buffer.from(`${admin.username}:${admin.password}`).toString("base64");
    const created = await request.post(`${apiUrl}/auth/users`, {
      headers: { authorization: `Basic ${basic}` },
      data: { username, password, role: "operator" },
    });
    expect(created.status()).toBe(201);

    try {
      await page.goto("/sessions?status=queued");
      await expect(page).toHaveURL(/\/login\?returnTo=%2Fsessions%3Fstatus%3Dqueued/);
      await expect(page.getByTestId("page-login")).toBeVisible();
      await expect(page.getByTestId("login-card")).toBeVisible();
      await expect(page.getByTestId("form-login")).toBeVisible();
      await page.getByTestId("login-username").fill(username);
      await page.getByTestId("login-password").fill("wrong-password");
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("login-error")).toHaveText("Invalid username or password.");

      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await expect(page).toHaveURL(/\/sessions\?status=queued$/);
      await expect(page.getByTestId("page-sessions")).toBeVisible();

      await page.getByTestId("nav-group-settings").click();
      await page.getByTestId("nav-settings").click();
      await expect(page).toHaveURL(/\/settings\/account/);
      await expect(page.getByTestId("page-settings")).toBeVisible();
      await expect(page.getByTestId("settings-heading")).toHaveText("Settings");
      await expect(page.getByTestId("account-details")).toBeVisible();
      await expect(page.getByTestId("account-username")).toHaveText(username);
      await expect(page.getByTestId("account-role")).toHaveText("operator");
      await expect(page.getByTestId("change-password-card")).toBeVisible();
      await expect(page.getByTestId("form-change-password")).toBeVisible();
      await page.getByTestId("change-password-current").fill("wrong-password");
      await page.getByTestId("change-password-new").fill(nextPassword);
      await page.getByTestId("change-password-submit").click();
      await expect(page.getByTestId("change-password-error")).toHaveText(
        "current password is incorrect",
      );
      await page.getByTestId("change-password-current").fill(password);
      await page.getByTestId("change-password-submit").click();
      await expect(page.getByTestId("change-password-ok")).toHaveText("Password changed.");

      await page.getByTestId("logout").click();
      await expect(page).toHaveURL(/\/login$/);
      await page.getByTestId("login-username").fill(username);
      await page.getByTestId("login-password").fill(password);
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("login-error")).toBeVisible();
      await page.getByTestId("login-password").fill(nextPassword);
      await page.getByTestId("login-submit").click();
      await expect(page.getByTestId("control-shell")).toBeVisible();

      await page.context().clearCookies();
      await page.context().addCookies([
        {
          name: "auto_harness_session",
          value: expiredSession(username),
          url: "http://127.0.0.1:7431",
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      await page.goto("/settings");
      await expect(page).toHaveURL(/\/login\?returnTo=%2Fsettings$/);
      await expect(page.getByTestId("service-accounts-card")).toHaveCount(0);
    } finally {
      await request.delete(`${apiUrl}/auth/users/${encodeURIComponent(username)}`, {
        headers: { authorization: `Basic ${basic}` },
      });
    }
  });

  // Bug 4 (redeploy findings): a locally valid session cookie names a principal the API
  // no longer recognizes — in AWS this was a cookie for an account revoked server-side;
  // here it's a well-formed, unexpired, correctly-signed cookie for a user who was never
  // created via POST /auth/users. Either way the asymmetry is the same: the web proxy's
  // `hasValidSession` (modules/shared/src/session-cookie.ts) verifies only the JWT's
  // signature/shape/expiry — it never calls the API — so it lets the request through,
  // while the API's own `verifySession`/`bindCurrentPrincipal`
  // (services/api/src/auth.ts) re-checks the account against live storage and returns
  // 401. `apiGet` (services/web/src/lib/api.ts) reacts to that 401 by calling
  // `redirect("/login")`, which every `app/**/page.tsx` currently awaits inside a bare
  // try/catch — swallowing the redirect's NEXT_REDIRECT control-flow error and
  // rendering it as literal text (confirmed live on /hosts) instead of redirecting.
  test("a session the API rejects but the proxy accepts still lands on /login, never leaking a digest", async ({
    page,
    context,
  }) => {
    const username = `pw-ghost-${test.info().parallelIndex}-${Date.now()}`;

    await context.addCookies([
      {
        name: "auto_harness_session",
        value: neverCreatedUserSession(username),
        url: controlOrigin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);

    await page.goto("/hosts");

    // Fixed behavior: the swallowed redirect is re-thrown and Next.js turns it into a
    // real 307 to /login (apiGet calls plain redirect("/login") — no returnTo — so the
    // fixed destination has no query string), which Playwright's goto follows
    // transparently. Buggy behavior: the response stays 200 on /hosts and the digest
    // renders as text instead of navigating anywhere.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("page-login")).toBeVisible();
    await expectNoLeakedNextDigest(page);
  });
});

function expiredSession(username: string): string {
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    id: `user:${username}`,
    username,
    role: "operator",
    kind: "user",
    exp: 0,
  })}`;
  return `${unsigned}.${createHmac("sha256", sessionSecret).update(unsigned).digest("base64url")}`;
}

/**
 * A well-formed, correctly-signed, *unexpired* session for a username that was never
 * registered via POST /auth/users. `hasValidSession` (the web proxy's local check)
 * accepts this — it only verifies signature, shape, and `exp` — but the API's
 * `bindCurrentPrincipal` finds no matching account and returns 401 for every
 * authenticated route, including the ones /hosts fetches on render.
 */
function neverCreatedUserSession(username: string): string {
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    id: `user:${username}`,
    username,
    role: "operator",
    kind: "user",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  return `${unsigned}.${createHmac("sha256", sessionSecret).update(unsigned).digest("base64url")}`;
}
