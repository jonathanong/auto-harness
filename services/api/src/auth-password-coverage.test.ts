import { expect, it } from "vitest";

import { AuthService } from "./auth.ts";

it("performs the dummy password comparison for an unknown username", async () => {
  const auth = new AuthService({ mode: "disabled" });
  await expect(auth.authenticatePassword("unknown", "password")).resolves.toBeNull();
});
