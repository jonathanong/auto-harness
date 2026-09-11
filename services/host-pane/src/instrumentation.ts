export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { initHostPaneSentryServer } = await import("./lib/sentry-server.ts");
  initHostPaneSentryServer();
}
