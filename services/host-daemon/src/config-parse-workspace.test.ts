import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";

const base = { hostId: "host", repositories: [] };

describe("workspace daemon config parsing", () => {
  it("accepts a workspace-only host and preserves configured slots", () => {
    expect(
      parseDaemonConfig({
        ...base,
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "slot", name: "slot", path: "/srv/workspaces/slot" }],
          },
        ],
      }),
    ).toMatchObject({
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "slot", name: "slot", path: "/srv/workspaces/slot" }],
        },
      ],
    });
  });

  it.each([{ ...base }, { ...base, workspacePools: [] }])(
    "requires at least one repository or workspace pool",
    (value) => {
      expect(() => parseDaemonConfig(value)).toThrow("unless workspacePools are configured");
    },
  );

  it.each([
    [{ ...base, workspacePools: {} }, "workspacePools must be an array"],
    [{ ...base, workspacePools: [null] }, "workspacePools[0] invalid"],
    [
      { ...base, workspacePools: [{ workspacePoolId: "pool", slots: null }] },
      "workspacePools.pool.slots must be an array",
    ],
    [
      { ...base, workspacePools: [{ workspacePoolId: "pool", slots: [null] }] },
      "workspacePools.pool.slots[0] invalid",
    ],
    [
      {
        ...base,
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [
              { id: "slot", name: "one", path: "/one" },
              { id: "slot", name: "two", path: "/two" },
            ],
          },
        ],
      },
      "workspacePools.pool.slots ids must be unique",
    ],
    [
      {
        ...base,
        workspacePools: [
          { workspacePoolId: "pool", slots: [] },
          { workspacePoolId: "pool", slots: [] },
        ],
      },
      "workspacePools ids must be unique",
    ],
  ])("rejects invalid workspace inventory", (value, message) => {
    expect(() => parseDaemonConfig(value, { allowEmptyRepositories: true })).toThrow(message);
  });

  it("allows an empty pre-attachment config when explicitly requested", () => {
    expect(parseDaemonConfig(base, { allowEmptyRepositories: true })).toMatchObject({
      repositories: [],
    });
  });
});
