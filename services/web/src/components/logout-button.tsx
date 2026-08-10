"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      data-pw="logout"
      onClick={() => {
        setPending(true);
        void apiFetch(
          "/api/v1/auth/logout",
          { method: "POST" },
          { redirectOnUnauthorized: false },
        ).then(() => {
          router.replace("/login");
          router.refresh();
        });
      }}
    >
      {pending ? "Logging out…" : "Logout"}
    </Button>
  );
}
