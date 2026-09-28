import { readFileSync } from "node:fs";
import { blackboardServer } from "../services/api/test-helpers/blackboard-server.ts";
import { BLACKBOARD_PORT } from "./harness-endpoints.ts";

const keyPath = process.env.HARNESS_E2E_BLACKBOARD_KEY;
const certPath = process.env.HARNESS_E2E_BLACKBOARD_CERT;
if (!keyPath || !certPath) throw new Error("e2e Blackboard TLS certificate is required");

const server = await blackboardServer({
  port: BLACKBOARD_PORT,
  tls: { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") },
});
console.log(`E2E Blackboard fixture listening on ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close());
}
