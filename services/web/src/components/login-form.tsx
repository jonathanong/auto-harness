"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@auto-harness/ui";

import { safeReturnPath } from "../lib/auth-session.ts";
import { apiFetch } from "../lib/client-api.ts";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="mx-auto w-full max-w-md" data-pw="login-card">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          data-pw="form-login"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const form = new FormData(event.currentTarget);
            const username = String(form.get("username") ?? "");
            const password = String(form.get("password") ?? "");
            start(async () => {
              const response = await apiFetch(
                "/api/v1/auth/login",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ username, password }),
                },
                { redirectOnUnauthorized: false },
              );
              if (!response.ok) {
                setError("Invalid username or password.");
                return;
              }
              router.replace(safeReturnPath(searchParams.get("returnTo")));
              router.refresh();
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              required
              data-pw="login-username"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              data-pw="login-password"
            />
          </div>
          {error ? (
            <p className="text-sm text-red-700" data-pw="login-error">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} data-pw="login-submit">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
