import { forwardSentryTunnel } from "@auto-harness/shared";

export async function POST(request: Request): Promise<Response> {
  const { status } = await forwardSentryTunnel({
    body: await request.text(),
    configuredDsn: process.env.HARNESS_HOST_PANE_SENTRY_DSN_CLIENT,
    method: "POST",
  });
  return new Response(null, { status });
}
