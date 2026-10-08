import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test" };

test("session output prints structured JSON values, including null", async () => {
  let requestUrl;
  const { io, stdout } = makeIo({
    env,
    fetch: async (url) => {
      requestUrl = url;
      return Response.json({ state: "ready", output: null, capturedAt: "2026-10-08T00:00:00Z" });
    },
  });
  assert.equal(await main(["session", "output", "session/one"], io), 0);
  assert.equal(requestUrl, "https://harness.test/api/v1/sessions/session%2Fone/output");
  assert.equal(stdout(), "null\ncaptured at 2026-10-08T00:00:00Z\n");
});

test("session artifacts JSON prints the complete response only on explicit request", async () => {
  const body = {
    state: "ready",
    downloadUrl: "https://bucket.test/signed?secret=token",
    expiresAt: "2026-10-08T00:05:00Z",
    capturedAt: "2026-10-08T00:00:00Z",
    contentType: "application/gzip",
    filename: "artifacts.tar.gz",
    compressedBytes: 42,
    sha256: "abc123",
  };
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(body) });
  assert.equal(await main(["session", "artifacts", "session-1", "--json"], io), 0);
  assert.equal(stdout(), `${JSON.stringify(body, null, 2)}\n`);
});

test("unsupported hosts are surfaced without parsing output", async () => {
  const { io, stdout } = makeIo({
    env,
    fetch: async () => Response.json({ state: "unsupported" }),
  });
  assert.equal(await main(["session", "output", "session-1"], io), 0);
  assert.equal(stdout(), "output is not supported by this host\n");
});

test("missing id and traversal id fail before making a request", async () => {
  const { io, stderr } = makeIo({
    env,
    fetch: async () => {
      throw new Error("unexpected request");
    },
  });
  assert.equal(await main(["session", "artifacts"], io), 2);
  assert.match(stderr(), /usage: auto-harness session artifacts/);
  const second = makeIo({
    env,
    fetch: async () => {
      throw new Error("unexpected request");
    },
  });
  assert.equal(await main(["session", "output", ".."], second.io), 2);
  assert.match(second.stderr(), /sessionId must not be/);
});
