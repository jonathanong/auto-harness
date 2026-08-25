/** Visible chrome + 401 copy: this UI is debug-only and has no login. */
export const HOST_PANE_DEBUG_ONLY_LABEL = "Debug-only";

export const HOST_PANE_UNAUTHENTICATED_HEADING = "This is the debug host pane";

export const HOST_PANE_UNAUTHENTICATED_BODY =
  "It has no login. Production session cookies live on the CloudFront control-plane domain. Use the control plane instead.";

/** Standalone 401 page for proxy.ts — no session cookie, no React shell. */
export function hostPaneUnauthenticatedHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${HOST_PANE_UNAUTHENTICATED_HEADING}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; max-width: 40rem; margin: 4rem auto; padding: 0 1.25rem; }
    h1 { font-size: 1.25rem; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>${HOST_PANE_UNAUTHENTICATED_HEADING}</h1>
    <p>${HOST_PANE_UNAUTHENTICATED_BODY}</p>
  </main>
</body>
</html>`;
}
