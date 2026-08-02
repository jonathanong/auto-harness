import { validateCreateSessionInput } from "@auto-harness/shared";

type CreateSessionFormInput = {
  repositoryId: string;
  prompt: string;
  commandProfile: string;
  timeout: number;
  ref?: string;
  concurrencyKey?: string;
  onConflict?: "queue" | "replace" | "reject";
  /** Profiles reported by agents — dropdown source of truth. */
  availableProfiles: string[];
};

type CreateSessionFormResult =
  | {
      ok: true;
      body: {
        repositoryId: string;
        prompt: string;
        commandProfile: string;
        timeout: number;
        ref?: string;
        concurrencyKey?: string;
        onConflict?: "queue" | "replace" | "reject";
        source: "ui";
      };
    }
  | { ok: false; error: string };

/**
 * Validate UI create-session form. Command profile must be one of the
 * agent-reported names (not free text).
 */
export function validateCreateSessionForm(input: CreateSessionFormInput): CreateSessionFormResult {
  if (!input.availableProfiles.includes(input.commandProfile)) {
    return {
      ok: false,
      error: `commandProfile must be one of: ${input.availableProfiles.join(", ") || "(none reported)"}`,
    };
  }
  const validated = validateCreateSessionInput({
    repositoryId: input.repositoryId,
    prompt: input.prompt,
    commandProfile: input.commandProfile,
    timeout: input.timeout,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    ...(input.concurrencyKey !== undefined ? { concurrencyKey: input.concurrencyKey } : {}),
    ...(input.onConflict !== undefined ? { onConflict: input.onConflict } : {}),
  });
  if (!validated.ok) {
    return validated;
  }
  const v = validated.value;
  return {
    ok: true,
    body: {
      repositoryId: v.repositoryId,
      prompt: v.prompt,
      commandProfile: v.commandProfile,
      timeout: v.timeout,
      source: "ui",
      ...(v.ref !== undefined ? { ref: v.ref } : {}),
      ...(v.concurrencyKey !== undefined ? { concurrencyKey: v.concurrencyKey } : {}),
      ...(input.onConflict !== undefined ? { onConflict: input.onConflict } : {}),
    },
  };
}

type ApiClient = {
  listCommandProfiles(): Promise<string[]>;
  createSession(body: unknown): Promise<{ status: number; body: unknown }>;
};

/**
 * UI create path: load agent-reported profiles, validate form, POST session.
 */
export async function createSessionFromUi(
  client: ApiClient,
  form: Omit<CreateSessionFormInput, "availableProfiles"> & {
    availableProfiles?: string[];
  },
): Promise<{ ok: true; session: unknown } | { ok: false; error: string; status?: number }> {
  const availableProfiles = form.availableProfiles ?? (await client.listCommandProfiles());
  const validated = validateCreateSessionForm({
    ...form,
    availableProfiles,
  });
  if (!validated.ok) {
    return validated;
  }
  const res = await client.createSession(validated.body);
  if (res.status !== 201) {
    const err =
      typeof res.body === "object" &&
      res.body !== null &&
      "error" in res.body &&
      typeof (res.body as { error?: { message?: string } }).error?.message === "string"
        ? (res.body as { error: { message: string } }).error.message
        : `create failed with status ${res.status}`;
    return { ok: false, error: err, status: res.status };
  }
  return { ok: true, session: res.body };
}

export function createHttpApiClient(baseUrl: string): ApiClient {
  return {
    async listCommandProfiles() {
      const res = await fetch(`${baseUrl}/api/v1/command-profiles`);
      const json = (await res.json()) as { items?: string[] };
      return json.items ?? [];
    },
    async createSession(body) {
      const res = await fetch(`${baseUrl}/api/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}
