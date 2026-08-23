import { describe, expect, it } from "vitest";

import { listRepositoriesDurable } from "./control-plane-durable-read-catalog.ts";
import { setRepositoryAdmissionDurable } from "./control-plane-repository-admission.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { RepositoryRecord } from "./db/plane-storage.ts";

describe("durable repository reads", () => {
  it("retries a scan that overlaps an admission activation", async () => {
    const paused: RepositoryRecord = {
      id: "repository",
      name: "repository",
      url: "https://example.test/repository",
      defaultBranch: "main",
      admissionState: "paused",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let releaseStaleScan!: (records: RepositoryRecord[]) => void;
    const staleScan = new Promise<RepositoryRecord[]>((resolve) => (releaseStaleScan = resolve));
    let listCalls = 0;
    let durableRepository = paused;
    const state = createControlPlaneState({
      storage: {
        listRepositories: async () => {
          listCalls += 1;
          if (listCalls === 1) return staleScan;
          return [{ ...durableRepository }];
        },
        getRepository: async () => ({ ...durableRepository }),
        listSchedules: async () => [],
        setRepositoryAdmissionState: async (_id, admissionState, updatedAt) => {
          durableRepository = { ...durableRepository, admissionState, updatedAt };
          return { ...durableRepository };
        },
      } as never,
    });

    const overlappingRead = listRepositoriesDurable(state);
    await expect(
      setRepositoryAdmissionDurable(state, "repository", "active"),
    ).resolves.toMatchObject({ ok: true, repository: { admissionState: "active" } });
    releaseStaleScan([{ ...paused }]);

    await expect(overlappingRead).resolves.toMatchObject([{ admissionState: "active" }]);
    expect(state.repositories.get("repository")).toMatchObject({ admissionState: "active" });
    expect(listCalls).toBe(2);
  });
});
