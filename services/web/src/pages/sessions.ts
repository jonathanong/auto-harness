import type { IncomingMessage, ServerResponse } from "node:http";

import { createSessionFromUi, validateCreateSessionForm } from "../create-session.ts";
import { escapeHtml, layout, readBody, send, simplePage } from "../html.ts";

type SessionClient = {
  listCommandProfiles(): Promise<string[]>;
  createSession(body: unknown): Promise<{ status: number; body: unknown }>;
};

export async function handleNewSessionGet(
  res: ServerResponse,
  client: SessionClient,
): Promise<void> {
  let profiles: string[] = [];
  let profilesError = "";
  try {
    profiles = await client.listCommandProfiles();
  } catch (err) {
    profilesError = err instanceof Error ? err.message : String(err);
  }
  const optionsHtml =
    profiles.length === 0
      ? `<option value="">(no agent profiles — start an agent)</option>`
      : profiles.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  const html = layout(
    "Auto Harness — New session",
    `<h1>Create session</h1>
  <p>Command profile is a <strong>dropdown of agent-reported names</strong> (D4) — not free text.</p>
  ${profilesError ? `<p class="err">Could not load profiles: ${escapeHtml(profilesError)}</p>` : ""}
  <form method="post" action="/sessions">
    <label>Repository id <input name="repositoryId" required value="demo"/></label>
    <label>Prompt <textarea name="prompt" required rows="4">hello from web</textarea></label>
    <label>Command profile
      <select name="commandProfile" required>${optionsHtml}</select>
    </label>
    <label>Timeout (seconds) <input name="timeout" type="number" min="1" value="60" required/></label>
    <label>Ref (branch/tag/SHA) <input name="ref" value="main"/></label>
    <button type="submit">Create session</button>
  </form>`,
  );
  send(res, 200, html);
}

export async function handleSessionsListGet(
  res: ServerResponse,
  apiBaseUrl: string,
): Promise<void> {
  const r = await fetch(`${apiBaseUrl}/api/v1/sessions`);
  const data = (await r.json()) as { items?: Array<Record<string, unknown>> };
  const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
  const rows = (data.items ?? [])
    .map((s) => {
      const id = String(s.id);
      const status = String(s.status);
      const cancel = terminal.has(status)
        ? ""
        : `<form method="post" action="/sessions/${escapeHtml(id)}/cancel" style="display:inline"><button type="submit">Cancel</button></form>`;
      return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(String(s.repositoryId ?? ""))}</td><td>${escapeHtml(String(s.commandProfile ?? ""))}</td><td>${escapeHtml(String(s.source ?? ""))}</td><td>${escapeHtml(String(s.ref ?? ""))}</td><td>${cancel}</td></tr>`;
    })
    .join("");
  send(
    res,
    200,
    layout(
      "Sessions",
      `<h1>Sessions</h1>
          <table><tr><th>id</th><th>status</th><th>repo</th><th>profile</th><th>source</th><th>ref</th><th></th></tr>${rows || "<tr><td colspan=7>(none)</td></tr>"}</table>`,
    ),
  );
}

export async function handleSessionCancelPost(
  res: ServerResponse,
  apiBaseUrl: string,
  sessionId: string,
): Promise<void> {
  const r = await fetch(`${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
  });
  const text = await r.text();
  send(
    res,
    r.status,
    simplePage(
      `<p class="${r.ok ? "ok" : "err"}">${r.ok ? "Cancelled" : "Cancel failed"}</p><pre>${escapeHtml(text)}</pre><p><a href="/sessions">Back</a></p>`,
    ),
  );
}

export async function handleSessionCreatePost(
  req: IncomingMessage,
  res: ServerResponse,
  client: SessionClient,
): Promise<void> {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const availableProfiles = await client.listCommandProfiles().catch(() => [] as string[]);
  const form = {
    repositoryId: params.get("repositoryId") ?? "",
    prompt: params.get("prompt") ?? "",
    commandProfile: params.get("commandProfile") ?? "",
    timeout: Number(params.get("timeout") ?? "0"),
    ref: params.get("ref") || undefined,
    availableProfiles,
  };
  // Validate first so free-text profiles never hit the API
  const validated = validateCreateSessionForm({
    repositoryId: form.repositoryId,
    prompt: form.prompt,
    commandProfile: form.commandProfile,
    timeout: form.timeout,
    availableProfiles,
    ...(form.ref ? { ref: form.ref } : {}),
  });
  if (!validated.ok) {
    send(
      res,
      400,
      `<!DOCTYPE html><html><body><p class="err">${escapeHtml(validated.error)}</p><p><a href="/">Back</a></p></body></html>`,
    );
    return;
  }
  const result = await createSessionFromUi(client, {
    repositoryId: form.repositoryId,
    prompt: form.prompt,
    commandProfile: form.commandProfile,
    timeout: form.timeout,
    availableProfiles,
    ...(form.ref ? { ref: form.ref } : {}),
  });
  if (!result.ok) {
    send(
      res,
      result.status ?? 500,
      `<!DOCTYPE html><html><body><p class="err">${escapeHtml(result.error)}</p><p><a href="/">Back</a></p></body></html>`,
    );
    return;
  }
  send(
    res,
    201,
    `<!DOCTYPE html><html><body>
            <p class="ok">Session created</p>
            <pre>${escapeHtml(JSON.stringify(result.session, null, 2))}</pre>
            <p><a href="/">Create another</a></p>
          </body></html>`,
  );
}

export async function handleCreateSessionApi(
  req: IncomingMessage,
  res: ServerResponse,
  client: SessionClient,
): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    send(res, 400, JSON.stringify({ error: "invalid JSON" }), "application/json");
    return;
  }
  const availableProfiles =
    (body.availableProfiles as string[] | undefined) ??
    (await client.listCommandProfiles().catch(() => [] as string[]));
  const result = await createSessionFromUi(client, {
    repositoryId: String(body.repositoryId ?? ""),
    prompt: String(body.prompt ?? ""),
    commandProfile: String(body.commandProfile ?? ""),
    timeout: Number(body.timeout ?? 0),
    availableProfiles,
    ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
  });
  if (!result.ok) {
    send(
      res,
      result.status ?? 400,
      JSON.stringify({ ok: false, error: result.error }),
      "application/json",
    );
    return;
  }
  send(res, 201, JSON.stringify({ ok: true, session: result.session }), "application/json");
}
