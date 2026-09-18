import assert from "node:assert/strict";
import test from "node:test";

import { CliConfigError } from "../src/cli/cli-errors.js";
import { createClient, resolveApiKey, resolveApiUrl } from "../src/cli/config.js";
import { makeIo } from "./cli-helpers.js";

test("--api-url flag wins over both env vars", () => {
  assert.equal(
    resolveApiUrl(
      { "--api-url": "https://flag" },
      { HARNESS_API_URL: "https://env-url", HARNESS_API_HTTP: "https://env-http" },
    ),
    "https://flag",
  );
});

test("HARNESS_API_URL wins over its HARNESS_API_HTTP alias", () => {
  assert.equal(
    resolveApiUrl({}, { HARNESS_API_URL: "https://env-url", HARNESS_API_HTTP: "https://env-http" }),
    "https://env-url",
  );
});

test("HARNESS_API_HTTP is honored as an alias when HARNESS_API_URL is unset", () => {
  assert.equal(resolveApiUrl({}, { HARNESS_API_HTTP: "https://alias" }), "https://alias");
});

test("a missing base URL is a config error naming both env vars", () => {
  assert.throws(
    () => resolveApiUrl({}, {}),
    (error) => {
      assert.ok(error instanceof CliConfigError);
      assert.match(error.message, /HARNESS_API_URL/);
      assert.match(error.message, /HARNESS_API_HTTP/);
      return true;
    },
  );
});

test("reads and trims the API key file named by --api-key-file", async () => {
  const { io } = makeIo({ files: { "/key.txt": "  secret-key\n" } });
  assert.equal(
    await resolveApiKey({ "--api-key-file": "/key.txt" }, io.env, io.readFile),
    "secret-key",
  );
});

test("reads and trims the API key file named by HARNESS_API_KEY_FILE", async () => {
  const { io } = makeIo({ files: { "/key.txt": "secret-key\n" } });
  assert.equal(
    await resolveApiKey({}, { HARNESS_API_KEY_FILE: "/key.txt" }, io.readFile),
    "secret-key",
  );
});

test("HARNESS_API_KEY is trimmed and used when no key file is configured", async () => {
  assert.equal(
    await resolveApiKey({}, { HARNESS_API_KEY: " secret \n" }, async () => {
      throw new Error("readFile should not be called");
    }),
    "secret",
  );
});

test("an unreadable --api-key-file is a config error", async () => {
  const { io } = makeIo({});
  await assert.rejects(
    resolveApiKey({ "--api-key-file": "/missing.txt" }, io.env, io.readFile),
    CliConfigError,
  );
});

test("no key configured resolves to undefined", async () => {
  const { io } = makeIo({});
  assert.equal(await resolveApiKey({}, io.env, io.readFile), undefined);
});

test("createClient wraps a rejected client construction as a config error", async () => {
  const { io } = makeIo({
    env: { HARNESS_API_URL: "http://example.com", HARNESS_API_KEY: "secret" },
  });
  await assert.rejects(createClient({}, io), (error) => {
    assert.ok(error instanceof CliConfigError);
    assert.match(error.message, /https/);
    return true;
  });
});

test("createClient builds a working client from resolved config", async () => {
  const { io } = makeIo({
    env: { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "secret" },
    fetch: async () => Response.json({ items: [], nextCursor: null }),
  });
  const client = await createClient({}, io);
  assert.deepEqual(await client.listRepositories(), { items: [], nextCursor: null });
});
