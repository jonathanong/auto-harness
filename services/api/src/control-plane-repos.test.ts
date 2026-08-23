import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { RepositoryRecord } from "./db/plane-storage.ts";

const repository = (id: string, admissionState?: string): RepositoryRecord => ({
  id,
  name: id,
  url: `https://example.test/${id}`,
  defaultBranch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...(admissionState === undefined ? {} : { admissionState: admissionState as never }),
});

it("omits malformed persisted admission rows while listing healthy repositories", async () => {
  const plane = new ControlPlane({
    storage: {
      listRepositories: async () => [repository("malformed", "unknown"), repository("healthy")],
    } as never,
  });

  await expect(plane.listRepositoriesDurable()).resolves.toMatchObject([
    { id: "healthy", admissionState: "active" },
  ]);
});
