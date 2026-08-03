import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createHttpApiClient,
  createSessionFromUi,
  validateCreateSessionForm,
} from "./create-session.js";

export type WebServerOptions = {
  port?: number;
  apiBaseUrl?: string;
};

function send(res: ServerResponse, status: number, body: string, type = "text/html"): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * Minimal Phase 4 local web entry: create-session form + profile dropdown.
 * Profiles and create go to the real API (not free-text commands).
 */
export async function startWebServer(options: WebServerOptions = {}): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 3000;
  const apiBaseUrl = options.apiBaseUrl ?? process.env.HARNESS_API_HTTP ?? "http://127.0.0.1:7420";
  const client = createHttpApiClient(apiBaseUrl);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        send(res, 200, JSON.stringify({ ok: true }), "application/json");
        return;
      }

      const nav = `<nav style="margin-bottom:1.5rem">
  <a href="/">New session</a> ·
  <a href="/sessions">Sessions</a> ·
  <a href="/repositories">Repositories</a> ·
  <a href="/schedules">Schedules</a> ·
  <a href="/agents">Agents</a>
</nav>`;
      const baseStyle = `body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}
  label{display:block;margin-top:1rem;font-weight:600}
  input,select,textarea{width:100%;padding:.4rem;margin-top:.25rem;box-sizing:border-box}
  button{margin-top:1.25rem;padding:.5rem 1rem}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #ccc;padding:.4rem;text-align:left}
  .err{color:#a00}.ok{color:#060} nav a{margin-right:.25rem}`;

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/sessions/new")) {
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
            : profiles
                .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
                .join("");
        const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Auto Harness — New session</title>
<style>${baseStyle}</style>
</head>
<body>
  ${nav}
  <h1>Create session</h1>
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
  </form>
</body>
</html>`;
        send(res, 200, html);
        return;
      }

      if (method === "GET" && url.pathname === "/sessions") {
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
          `<!DOCTYPE html><html><head><style>${baseStyle}</style></head><body>${nav}
          <h1>Sessions</h1>
          <table><tr><th>id</th><th>status</th><th>repo</th><th>profile</th><th>source</th><th>ref</th><th></th></tr>${rows || "<tr><td colspan=7>(none)</td></tr>"}</table>
          </body></html>`,
        );
        return;
      }

      const cancelSessionMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(url.pathname);
      if (method === "POST" && cancelSessionMatch) {
        const r = await fetch(
          `${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(cancelSessionMatch[1]!)}/cancel`,
          { method: "POST" },
        );
        const text = await r.text();
        send(
          res,
          r.status,
          `<!DOCTYPE html><html><body>${nav}<p class="${r.ok ? "ok" : "err"}">${r.ok ? "Cancelled" : "Cancel failed"}</p><pre>${escapeHtml(text)}</pre><p><a href="/sessions">Back</a></p></body></html>`,
        );
        return;
      }

      if (method === "GET" && url.pathname === "/repositories") {
        const r = await fetch(`${apiBaseUrl}/api/v1/repositories`);
        const data = (await r.json()) as { items?: Array<Record<string, unknown>> };
        const rows = (data.items ?? [])
          .map(
            (repo) =>
              `<tr><td>${escapeHtml(String(repo.id))}</td><td>${escapeHtml(String(repo.name))}</td><td>${escapeHtml(String(repo.url))}</td><td>${escapeHtml(String(repo.defaultBranch ?? ""))}</td></tr>`,
          )
          .join("");
        send(
          res,
          200,
          `<!DOCTYPE html><html><head><style>${baseStyle}</style></head><body>${nav}
          <h1>Repositories</h1>
          <table><tr><th>id</th><th>name</th><th>url</th><th>defaultBranch</th></tr>${rows || "<tr><td colspan=4>(none)</td></tr>"}</table>
          <h2>Add repository</h2>
          <form method="post" action="/repositories">
            <label>id (optional) <input name="id"/></label>
            <label>name <input name="name" required/></label>
            <label>url / path <input name="url" required/></label>
            <label>defaultBranch <input name="defaultBranch" value="main"/></label>
            <label>setupScript <input name="setupScript"/></label>
            <label>terminalHookScript <input name="terminalHookScript"/></label>
            <button type="submit">Create repository</button>
          </form>
          </body></html>`,
        );
        return;
      }

      if (method === "POST" && url.pathname === "/repositories") {
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        const body: Record<string, string> = {
          name: params.get("name") ?? "",
          url: params.get("url") ?? "",
        };
        if (params.get("id")) body.id = params.get("id")!;
        if (params.get("defaultBranch")) body.defaultBranch = params.get("defaultBranch")!;
        if (params.get("setupScript")) body.setupScript = params.get("setupScript")!;
        if (params.get("terminalHookScript"))
          body.terminalHookScript = params.get("terminalHookScript")!;
        const r = await fetch(`${apiBaseUrl}/api/v1/repositories`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        if (!r.ok) {
          send(
            res,
            r.status,
            `<!DOCTYPE html><html><body>${nav}<p class="err">${escapeHtml(text)}</p><p><a href="/repositories">Back</a></p></body></html>`,
          );
          return;
        }
        send(
          res,
          201,
          `<!DOCTYPE html><html><body>${nav}<p class="ok">Repository created</p><pre>${escapeHtml(text)}</pre><p><a href="/repositories">Back</a></p></body></html>`,
        );
        return;
      }

      if (method === "GET" && url.pathname === "/schedules") {
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
          `<!DOCTYPE html><html><head><style>${baseStyle}</style></head><body>${nav}
          <h1>Schedules</h1>
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
          </form>
          </body></html>`,
        );
        return;
      }

      if (method === "POST" && url.pathname === "/schedules") {
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
          `<!DOCTYPE html><html><body>${nav}<pre>${escapeHtml(text)}</pre><p><a href="/schedules">Back</a></p></body></html>`,
        );
        return;
      }

      const triggerMatch = /^\/schedules\/([^/]+)\/trigger$/.exec(url.pathname);
      if (method === "POST" && triggerMatch) {
        const r = await fetch(
          `${apiBaseUrl}/api/v1/schedules/${encodeURIComponent(triggerMatch[1]!)}/trigger`,
          { method: "POST" },
        );
        const text = await r.text();
        send(
          res,
          r.status,
          `<!DOCTYPE html><html><body>${nav}<p class="ok">Triggered</p><pre>${escapeHtml(text)}</pre><p><a href="/schedules">Back</a></p></body></html>`,
        );
        return;
      }

      if (method === "GET" && url.pathname === "/agents") {
        const r = await fetch(`${apiBaseUrl}/api/v1/agents`);
        const data = (await r.json()) as { items?: Array<Record<string, unknown>> };
        const rows = (data.items ?? [])
          .map(
            (a) =>
              `<tr><td>${escapeHtml(String(a.agentId))}</td><td>${escapeHtml(String(a.online))}</td><td>${escapeHtml(JSON.stringify(a.commandProfiles ?? []))}</td>
              <td><form method="post" action="/agents/drain" style="display:inline">
                <input type="hidden" name="agentId" value="${escapeHtml(String(a.agentId))}"/>
                <button type="submit">Drain</button>
              </form></td></tr>`,
          )
          .join("");
        send(
          res,
          200,
          `<!DOCTYPE html><html><head><style>${baseStyle}</style></head><body>${nav}
          <h1>Agents</h1>
          <table><tr><th>agentId</th><th>online</th><th>profiles</th><th></th></tr>${rows || "<tr><td colspan=4>(none)</td></tr>"}</table>
          </body></html>`,
        );
        return;
      }

      if (method === "POST" && url.pathname === "/agents/drain") {
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        const agentId = params.get("agentId") ?? "";
        const r = await fetch(`${apiBaseUrl}/api/v1/agents/drain`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId }),
        });
        const text = await r.text();
        send(
          res,
          r.status,
          `<!DOCTYPE html><html><body>${nav}<p class="${r.ok ? "ok" : "err"}">${r.ok ? "Drain requested" : "Drain failed"}</p><pre>${escapeHtml(text)}</pre><p><a href="/agents">Back</a></p></body></html>`,
        );
        return;
      }

      if (method === "POST" && url.pathname === "/sessions") {
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
        return;
      }

      if (method === "POST" && url.pathname === "/api/create-session") {
        // JSON API used by tests — drives real createSessionFromUi
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
        return;
      }

      send(res, 404, "not found", "text/plain");
    })().catch((err) => {
      send(res, 500, String(err), "text/plain");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function main(argv: string[] = process.argv): Promise<number> {
  const args = argv.slice(2);
  let port = 3000;
  const portIdx = args.indexOf("--port");
  if (portIdx >= 0) {
    port = Number(args[portIdx + 1]);
  }
  return startWebServer({ port }).then((s) => {
    console.log(`Auto Harness web on http://127.0.0.1:${s.port}`);
    return new Promise(() => {
      /* run until killed */
    });
  });
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  void main();
}
