import type { IncomingMessage, ServerResponse } from "node:http";

import { escapeHtml, layout, readBody, send, simplePage } from "../html.ts";

export async function handleSchedulesGet(res: ServerResponse, apiBaseUrl: string): Promise<void> {
  const r = await fetch(`${apiBaseUrl}/api/v1/schedules`);
  const data = (await r.json()) as { items?: Array<Record<string, unknown>> };
  const rows = (data.items ?? [])
    .map(
      (s) =>
        `<tr><td>${escapeHtml(String(s.id))}</td><td>${escapeHtml(String(s.name))}</td><td>${escapeHtml(String(s.repositoryId))}</td><td>${escapeHtml(String(s.commandProfile))}</td><td>${escapeHtml(String(s.cron))}</td><td>${escapeHtml(String(s.enabled))}</td>
              <td><form method="post" action="/schedules/${escapeHtml(String(s.id))}/trigger" style="display:inline"><button type="submit">Trigger</button></form></td></tr>`,
    )
    .join("");
  send(
    res,
    200,
    layout(
      "Schedules",
      `<h1>Schedules</h1>
          <table><tr><th>id</th><th>name</th><th>repo</th><th>profile</th><th>cron</th><th>enabled</th><th></th></tr>${rows || "<tr><td colspan=7>(none)</td></tr>"}</table>
          <h2>Add schedule</h2>
          <form method="post" action="/schedules">
            <label>repositoryId <input name="repositoryId" required value="demo"/></label>
            <label>name <input name="name" required/></label>
            <label>commandProfile <input name="commandProfile" required value="echo-prompt"/></label>
            <label>cron <input name="cron" required value="0 * * * *"/></label>
            <label>timeout <input name="timeout" type="number" required value="60"/></label>
            <label>nextRunAt (ISO) <input name="nextRunAt" required value="${new Date().toISOString()}"/></label>
            <label>ref <input name="ref" value="main"/></label>
            <button type="submit">Create schedule</button>
          </form>`,
    ),
  );
}

export async function handleSchedulesPost(
  req: IncomingMessage,
  res: ServerResponse,
  apiBaseUrl: string,
): Promise<void> {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const body = {
    repositoryId: params.get("repositoryId") ?? "",
    name: params.get("name") ?? "",
    commandProfile: params.get("commandProfile") ?? "",
    cron: params.get("cron") ?? "",
    timeout: Number(params.get("timeout") ?? "0"),
    nextRunAt: params.get("nextRunAt") ?? new Date().toISOString(),
    ...(params.get("ref") ? { ref: params.get("ref") } : {}),
  };
  const r = await fetch(`${apiBaseUrl}/api/v1/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  send(
    res,
    r.status,
    simplePage(`<pre>${escapeHtml(text)}</pre><p><a href="/schedules">Back</a></p>`),
  );
}

export async function handleScheduleTriggerPost(
  res: ServerResponse,
  apiBaseUrl: string,
  scheduleId: string,
): Promise<void> {
  const r = await fetch(
    `${apiBaseUrl}/api/v1/schedules/${encodeURIComponent(scheduleId)}/trigger`,
    { method: "POST" },
  );
  const text = await r.text();
  send(
    res,
    r.status,
    simplePage(
      `<p class="ok">Triggered</p><pre>${escapeHtml(text)}</pre><p><a href="/schedules">Back</a></p>`,
    ),
  );
}
