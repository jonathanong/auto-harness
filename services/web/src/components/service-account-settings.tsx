"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@auto-harness/ui";

import {
  createServiceAccount,
  deleteServiceAccount,
  loadServiceAccountData,
  type RepositoryOption,
  type ServiceAccount,
  type ServiceAccountInput,
  type ServiceAccountSecret,
} from "./service-account-api.ts";
import { ServiceAccountCreateForm } from "./service-account-create-form.tsx";
import { ServiceAccountKeyDialog } from "./service-account-key-dialog.tsx";
import { ServiceAccountTable } from "./service-account-table.tsx";

type State =
  | { kind: "loading" }
  | { kind: "ready"; accounts: ServiceAccount[]; repositories: RepositoryOption[] }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export function ServiceAccountSettings({ canManage }: { canManage: boolean }) {
  const [state, setState] = useState<State>(
    canManage ? { kind: "loading" } : { kind: "forbidden" },
  );
  const [secret, setSecret] = useState<
    { value: ServiceAccountSecret; rotatedFromId?: string } | undefined
  >();
  useEffect(() => {
    if (!canManage) return;
    let active = true;
    void loadServiceAccountData()
      .then((result) => {
        if (!active || result.kind === "unauthorized") return;
        setState(result);
      })
      .catch((cause) => {
        if (active)
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : "Unable to load service accounts.",
          });
      });
    return () => {
      active = false;
    };
  }, [canManage]);

  if (state.kind === "loading") {
    return <div aria-busy="true" />;
  }
  if (state.kind === "forbidden") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Service accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <p
            className="text-sm text-red-700"
            role="alert"
            data-pw="service-accounts-forbidden-error"
          >
            An unscoped admin account is required to manage service accounts.
          </p>
        </CardContent>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Service accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-700" role="alert">
            {state.message}
          </p>
        </CardContent>
      </Card>
    );
  }

  const addSecret = (value: ServiceAccountSecret, rotatedFromId?: string) => {
    setState((current) =>
      current.kind === "ready"
        ? { ...current, accounts: [...current.accounts, value.account] }
        : current,
    );
    setSecret({ value, ...(rotatedFromId ? { rotatedFromId } : {}) });
  };
  const remove = async (id: string) => {
    await deleteServiceAccount(id);
    setState((current) =>
      current.kind === "ready"
        ? { ...current, accounts: current.accounts.filter((account) => account.id !== id) }
        : current,
    );
    setSecret((current) => (current?.rotatedFromId === id ? { value: current.value } : current));
  };
  const create = async (input: ServiceAccountInput) => addSecret(await createServiceAccount(input));
  const rotate = async (account: ServiceAccount) => {
    const input: ServiceAccountInput = {
      name: account.name,
      role: account.role,
      ...(account.allowedRepositoryIds
        ? { allowedRepositoryIds: account.allowedRepositoryIds }
        : {}),
      ...(account.boundHostId ? { boundHostId: account.boundHostId } : {}),
    };
    addSecret(await createServiceAccount(input), account.id);
  };
  return (
    <Card data-pw="service-accounts-card">
      <CardHeader>
        <CardTitle>Service accounts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <ServiceAccountCreateForm repositories={state.repositories} onCreate={create} />
        <ServiceAccountTable
          accounts={state.accounts}
          repositories={state.repositories}
          onRotate={rotate}
          onDelete={remove}
        />
      </CardContent>
      {secret ? (
        <ServiceAccountKeyDialog
          secret={secret.value}
          {...(secret.rotatedFromId ? { rotatedFromId: secret.rotatedFromId } : {})}
          onDismiss={() => setSecret(undefined)}
          onRevokeOld={remove}
        />
      ) : null}
    </Card>
  );
}
