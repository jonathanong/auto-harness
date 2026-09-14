import { describe, expect, it, vi } from "vitest";

import { deleteLog } from "./db/plane-storage-catalog.ts";

describe("SessionLogs table removal", () => {
  it("skips deleteLog when the SessionLogs table is not provisioned", async () => {
    const send = vi.fn();
    await deleteLog({ doc: { send }, tables: {} } as never, "session", "ts");
    expect(send).not.toHaveBeenCalled();
  });
});
