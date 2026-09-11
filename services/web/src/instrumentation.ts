export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { initWebSentryServer } = await import("./lib/sentry-server.ts");
  initWebSentryServer();
}
