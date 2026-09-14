export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const base = (process.env.HARNESS_DAEMON_HTTP ?? "http://127.0.0.1:7424").replace(/\/$/, "");
  try {
    const upstream = await fetch(`${base}/sessions/${encodeURIComponent(id)}/logs/stream`, {
      cache: "no-store",
    });
    if (!upstream.ok || !upstream.body) {
      return new Response("live log stream unavailable", { status: 502 });
    }
    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  } catch {
    return new Response("live log stream unavailable", { status: 502 });
  }
}
