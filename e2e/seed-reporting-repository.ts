import { createDynamoClients, tableNames } from "../services/api/src/db/dynamo.ts";
import { DynamoPlaneStorage } from "../services/api/src/db/plane-storage.ts";
import { E2E_REPORTING_REPOSITORIES } from "./reporting-fixture.ts";

const { doc } = createDynamoClients();
const storage = new DynamoPlaneStorage(
  doc,
  tableNames(process.env.HARNESS_DDB_PREFIX ?? "AutoHarness"),
);
const now = new Date().toISOString();
for (const repository of Object.values(E2E_REPORTING_REPOSITORIES)) {
  await storage.putRepository({
    id: repository.id,
    name: repository.name,
    url: `https://example.test/${repository.name}.git`,
    defaultBranch: "main",
    admissionState: "active",
    createdAt: now,
    updatedAt: now,
  });
}
