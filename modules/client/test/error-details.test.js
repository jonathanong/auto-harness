import assert from "node:assert/strict";
import test from "node:test";

import { AutoHarnessClient, AutoHarnessError } from "../src/index.js";

test("preserves the full response error body as details", async () => {
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "HAS_DEPENDENCIES",
            message: "cannot delete: still referenced",
            dependencies: [{ kind: "session", id: "s1" }],
          },
        },
        { status: 409 },
      ),
  });
  await assert.rejects(client.listRepositories(), (error) => {
    assert.ok(error instanceof AutoHarnessError);
    assert.deepEqual(error.details, {
      code: "HAS_DEPENDENCIES",
      message: "cannot delete: still referenced",
      dependencies: [{ kind: "session", id: "s1" }],
    });
    return true;
  });
});

test("leaves details undefined when the response body has no error object", async () => {
  const client = new AutoHarnessClient({
    baseUrl: "https://harness.test",
    fetch: async () => new Response("not json", { status: 500 }),
  });
  await assert.rejects(client.listRepositories(), (error) => {
    assert.ok(error instanceof AutoHarnessError);
    assert.equal(error.details, undefined);
    return true;
  });
});
