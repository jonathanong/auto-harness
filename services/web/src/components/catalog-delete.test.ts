import { describe, expect, it, vi } from "vitest";

import { deleteCatalogResource } from "./catalog-delete.ts";

describe("deleteCatalogResource", () => {
  it("returns null after a successful deletion", async () => {
    await expect(
      deleteCatalogResource(
        vi.fn(async () => new Response(null, { status: 204 })),
        "/thing",
      ),
    ).resolves.toBeNull();
  });

  it("uses structured API errors and status fallbacks", async () => {
    await expect(
      deleteCatalogResource(
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { message: "still referenced" } }), {
              status: 409,
            }),
        ),
        "/thing",
      ),
    ).resolves.toBe("still referenced");
    await expect(
      deleteCatalogResource(
        vi.fn(async () => new Response("not json", { status: 503 })),
        "/thing",
      ),
    ).resolves.toBe("not json");
  });

  it("normalizes transport failures", async () => {
    for (const [cause, expected] of [
      [new Error("offline"), "offline"],
      [new Error(), "request failed"],
      ["offline", "request failed"],
    ] as const) {
      await expect(
        deleteCatalogResource(
          vi.fn(async () => {
            throw cause;
          }),
          "/thing",
        ),
      ).resolves.toBe(expected);
    }
  });
});
