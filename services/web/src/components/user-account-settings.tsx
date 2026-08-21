"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@auto-harness/ui";

import type { RepositoryOption } from "./service-account-api.ts";
import {
  createUserAccount,
  deleteUserAccount,
  loadUserAccounts,
  type UserAccount,
  type UserAccountInput,
} from "./user-account-api.ts";
import { UserAccountCreateForm } from "./user-account-create-form.tsx";
import { UserAccountTable } from "./user-account-table.tsx";

type State =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export function UserAccountSettings({ canManage }: { canManage: boolean }) {
  const [state, setState] = useState<State>(
    canManage ? { kind: "loading" } : { kind: "forbidden" },
  );
  const [accounts, setAccounts] = useState<UserAccount[]>([]);
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  useEffect(() => {
    if (!canManage) return;
    let active = true;
    void loadUserAccounts()
      .then((result) => {
        if (!active || result.kind === "unauthorized") return;
        if (result.kind === "ready") {
          setAccounts(result.accounts);
          setRepositories(result.repositories);
          setState({ kind: "ready" });
        } else {
          setState(result);
        }
      })
      .catch((cause) => {
        if (active)
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : "Unable to load user accounts.",
          });
      });
    return () => {
      active = false;
    };
  }, [canManage]);

  if (state.kind === "loading") {
    return (
      <Card data-pw="user-accounts-loading" aria-busy="true">
        <CardHeader>
          <CardTitle>User accounts</CardTitle>
        </CardHeader>
      </Card>
    );
  }
  if (state.kind === "forbidden") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>User accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-700" role="alert" data-pw="user-accounts-forbidden-error">
            An unscoped admin account is required to manage user accounts.
          </p>
        </CardContent>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card data-pw="user-accounts-error">
        <CardHeader>
          <CardTitle>User accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-700" role="alert">
            {state.message}
          </p>
        </CardContent>
      </Card>
    );
  }

  const create = async (input: UserAccountInput) => {
    const account = await createUserAccount(input);
    setAccounts((current) => [...current, account]);
  };
  const remove = async (username: string) => {
    await deleteUserAccount(username);
    setAccounts((current) => current.filter((account) => account.username !== username));
  };
  return (
    <Card data-pw="user-accounts-card">
      <CardHeader>
        <CardTitle>User accounts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <UserAccountCreateForm repositories={repositories} onCreate={create} />
        <UserAccountTable accounts={accounts} onDelete={remove} />
      </CardContent>
    </Card>
  );
}
