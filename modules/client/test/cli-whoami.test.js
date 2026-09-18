import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli/main.js";
import { makeIo } from "./cli-helpers.js";

const env = { HARNESS_API_URL: "https://harness.test", HARNESS_API_KEY: "secret" };

const ADMIN_PRINCIPAL = {
  id: "user-1",
  kind: "admin",
  username: "root",
  passwordHash: "$2b$12$totally-secret-hash",
  role: "admin",
  capabilities: ["manage:hosts", "manage:repositories"],
  allowedRepositoryIds: ["repo-1"],
};

const SERVICE_ACCOUNT_PRINCIPAL = {
  id: "svc-1",
  kind: "service-account",
  name: "ci-bot",
  apiKeyHash: "hash-value",
  role: "operator",
  capabilities: ["dispatch:sessions"],
  boundHostId: "host-1",
};

test("whoami prints only allowlisted fields in human form and never a password hash", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(ADMIN_PRINCIPAL) });
  const exitCode = await main(["whoami"], io);
  assert.equal(exitCode, 0);
  const text = stdout();
  assert.ok(!text.includes("passwordHash"));
  assert.ok(!text.includes("totally-secret-hash"));
  assert.match(text, /id: user-1/);
  assert.match(text, /kind: admin/);
  assert.match(text, /username: root/);
  assert.match(text, /role: admin/);
  assert.match(text, /capabilities: manage:hosts, manage:repositories/);
  assert.match(text, /allowedRepositoryIds: repo-1/);
});

test("whoami --json prints only the allowlisted object and never a password hash", async () => {
  const { io, stdout } = makeIo({ env, fetch: async () => Response.json(ADMIN_PRINCIPAL) });
  const exitCode = await main(["whoami", "--json"], io);
  assert.equal(exitCode, 0);
  const text = stdout();
  assert.ok(!text.includes("passwordHash"));
  const parsed = JSON.parse(text);
  assert.equal(parsed.passwordHash, undefined);
  assert.deepEqual(Object.keys(parsed).toSorted(), [
    "allowedRepositoryIds",
    "capabilities",
    "id",
    "kind",
    "role",
    "username",
  ]);
});

test("whoami never prints a service account's apiKeyHash, in either format", async () => {
  const humanIo = makeIo({ env, fetch: async () => Response.json(SERVICE_ACCOUNT_PRINCIPAL) });
  await main(["whoami"], humanIo.io);
  assert.ok(!humanIo.stdout().includes("apiKeyHash"));
  assert.ok(!humanIo.stdout().includes("hash-value"));

  const jsonIo = makeIo({ env, fetch: async () => Response.json(SERVICE_ACCOUNT_PRINCIPAL) });
  await main(["whoami", "--json"], jsonIo.io);
  const parsed = JSON.parse(jsonIo.stdout());
  assert.equal(parsed.apiKeyHash, undefined);
  assert.deepEqual(Object.keys(parsed).toSorted(), [
    "boundHostId",
    "capabilities",
    "id",
    "kind",
    "name",
    "role",
  ]);
});

test("whoami rejects unexpected positional arguments", async () => {
  const { io, stderr } = makeIo({ env });
  const exitCode = await main(["whoami", "extra"], io);
  assert.equal(exitCode, 2);
  assert.match(stderr(), /takes no arguments/);
});
