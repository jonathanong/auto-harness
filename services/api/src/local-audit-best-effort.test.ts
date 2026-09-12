import { describe, expect, it, vi } from "vitest";

import { writeSystemAuditBestEffort } from "./local-audit.ts";

describe("best-effort system audit", () => {
  it("uses an authenticated actor and explicit outcome without surfacing append failure", async () => {
    const appendAuditLog = vi.fn().mockRejectedValue(new Error("audit unavailable"));
    await expect(
      writeSystemAuditBestEffort(
        {
          plane: { appendAuditLog },
          principal: { id: "user-1", email: "user@example.com", roles: ["admin"] },
        } as never,
        {
          action: "integration:slack:event:accepted",
          resourceType: "integration",
          resourceId: "slack",
          outcome: "failed",
        },
      ),
    ).resolves.toBeUndefined();
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        actor: expect.objectContaining({ id: "user-1" }),
      }),
    );
  });

  it("defaults an omitted outcome to success", async () => {
    const appendAuditLog = vi.fn().mockResolvedValue(undefined);
    await writeSystemAuditBestEffort({ plane: { appendAuditLog }, principal: undefined } as never, {
      action: "integration:slack:event:accepted",
      resourceType: "integration",
      resourceId: "slack",
    });
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });
});
