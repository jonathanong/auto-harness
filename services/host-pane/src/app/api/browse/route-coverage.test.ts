import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;
const originalBrowseRoot = process.env.HARNESS_HOST_PANE_BROWSE_ROOT;
const originalSecret = process.env.HARNESS_SESSION_SECRET;
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
  vi.resetModules();
  restoreEnv("HARNESS_AUTH_MODE", originalAuthMode);
  restoreEnv("HARNESS_HOST_PANE_BROWSE_ROOT", originalBrowseRoot);
  restoreEnv("HARNESS_SESSION_SECRET", originalSecret);
});

describe("GET /api/browse", () => {
  it("lists only matching visible directories inside the configured root", async () => {
    const root = await createFixture();
    await Promise.all([
      mkdir(join(root, "alpha")),
      mkdir(join(root, "Alpine")),
      mkdir(join(root, ".hidden")),
      mkdir(join(root, "beta")),
      writeFile(join(root, "alpine-file"), "not a directory"),
    ]);
    const { GET } = await loadRoute(root);

    const response = await GET(
      new Request(`http://host/api/browse?path=${encodeURIComponent(`${root}/al`)}`),
    );

    expect(await response.json()).toEqual({ items: [join(root, "alpha"), join(root, "Alpine")] });
  });

  it("lists the configured root for empty input, includes dot directories only for dot prefixes, and limits subdirectory results", async () => {
    const root = await createFixture();
    const choices = join(root, "choices");
    await mkdir(choices);
    await mkdir(join(choices, ".config"));
    await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        mkdir(join(choices, `item-${index.toString().padStart(2, "0")}`)),
      ),
    );
    const { GET } = await loadRoute(root);

    const rootResponse = await GET(new Request("http://host/api/browse?path=%20%20"));
    const choicesResponse = await GET(
      new Request(`http://host/api/browse?path=${encodeURIComponent(`${choices}/`)}`),
    );
    const dotResponse = await GET(
      new Request(`http://host/api/browse?path=${encodeURIComponent(`${choices}/.`)}`),
    );

    expect(await rootResponse.json()).toEqual({ items: [choices] });
    expect((await choicesResponse.json()).items).toHaveLength(20);
    expect(await dotResponse.json()).toEqual({ items: [join(choices, ".config")] });
  });

  it("rejects lexical and symlink escapes and treats inaccessible paths as empty", async () => {
    const root = await createFixture();
    const outside = await createFixture();
    await mkdir(join(outside, "outside-dir"));
    await symlink(outside, join(root, "escape"));
    const { GET } = await loadRoute(root);

    const outsideResponse = await GET(new Request("http://host/api/browse?path=/tmp/outside"));
    const disguisedRoot = `${root}/../${root.split("/").at(-1)}`;
    const parentResponse = await GET(
      new Request(`http://host/api/browse?path=${encodeURIComponent(disguisedRoot)}`),
    );
    const symlinkResponse = await GET(
      new Request(`http://host/api/browse?path=${encodeURIComponent(`${root}/escape/`)}`),
    );
    const missingResponse = await GET(
      new Request(`http://host/api/browse?path=${encodeURIComponent(`${root}/missing/`)}`),
    );

    expect(await outsideResponse.json()).toEqual({ items: [] });
    expect(await parentResponse.json()).toEqual({ items: [] });
    expect(await symlinkResponse.json()).toEqual({ items: [] });
    expect(await missingResponse.json()).toEqual({ items: [] });
  });

  it("requires a current, correctly signed HS256 session only when authentication is enabled", async () => {
    const root = await createFixture();
    const { GET } = await loadRoute(root, { auth: true, secret: "test-secret" });
    const valid = session("test-secret", { alg: "HS256", typ: "JWT" }, { exp: futureExpiry() });
    const cases = [
      undefined,
      "auto_harness_session=only.two",
      "auto_harness_session=..signature",
      "auto_harness_session=header..signature",
      "auto_harness_session=header.payload.",
      `auto_harness_session=${valid.slice(0, -1)}`,
      `auto_harness_session=${corruptSignature(valid)}`,
      `auto_harness_session=${session("test-secret", { alg: "none", typ: "JWT" }, { exp: futureExpiry() })}`,
      `auto_harness_session=${session("test-secret", { alg: "HS256", typ: "other" }, { exp: futureExpiry() })}`,
      `auto_harness_session=${session("test-secret", { alg: "HS256", typ: "JWT" }, { exp: "future" })}`,
      `auto_harness_session=${signedRaw("test-secret", Buffer.from("{").toString("base64url"), Buffer.from("{}").toString("base64url"))}`,
      `auto_harness_session=${session("test-secret", { alg: "HS256", typ: "JWT" }, { exp: 0 })}`,
    ];

    for (const cookie of cases) {
      const response = await GET(
        new Request("http://host/api/browse", { headers: cookie ? { cookie } : {} }),
      );
      expect(response.status).toBe(401);
    }
    const response = await GET(
      new Request("http://host/api/browse", {
        headers: { cookie: `other=x; auto_harness_session=${valid}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects required-mode requests when the session secret is unavailable", async () => {
    const root = await createFixture();
    const { GET } = await loadRoute(root, { auth: true });

    expect(
      (
        await GET(
          new Request("http://host/api/browse", {
            headers: { cookie: "auto_harness_session=x.y.z" },
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("uses the home directory boundary when no browse root is configured", async () => {
    restoreEnv("HARNESS_HOST_PANE_BROWSE_ROOT", undefined);
    vi.resetModules();
    const { GET } = await import("./route.ts");

    expect(
      await (await GET(new Request("http://host/api/browse?path=/tmp/outside"))).json(),
    ).toEqual({ items: [] });
  });
});

async function createFixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "auto-harness-browse-"));
  temporaryPaths.push(path);
  return path;
}

async function loadRoute(root: string, options: { auth?: boolean; secret?: string } = {}) {
  process.env.HARNESS_HOST_PANE_BROWSE_ROOT = root;
  restoreEnv("HARNESS_AUTH_MODE", options.auth ? "required" : undefined);
  restoreEnv("HARNESS_SESSION_SECRET", options.secret);
  vi.resetModules();
  return import("./route.ts");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function session(secret: string, header: object, payload: object): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signedRaw(secret, encodedHeader, encodedPayload);
}

function signedRaw(secret: string, header: string, payload: string): string {
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function corruptSignature(token: string): string {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const first = signature.startsWith("A") ? "B" : "A";
  return `${header}.${payload}.${first}${signature.slice(1)}`;
}

function futureExpiry(): number {
  return Date.now() / 1000 + 60;
}
