/**
 * The only place a control-plane base URL is turned into the daemon's WebSocket target.
 *
 * `resolveWsUrl` swaps http(s) for ws(s) and appends `/ws` only when the caller supplied no
 * path — an explicit path (including a bare `/ws`) is left untouched. This replaced a substring
 * check (`url.includes("/ws")`) that both false-positived on any host containing the literal
 * text "ws" (`wss://ws.example.com`) and false-negatived on a path like `/workspaces`.
 *
 * A raw API Gateway WebSocket endpoint (`*.execute-api.*.amazonaws.com`) is rejected by
 * default: it is never the right value for HARNESS_API_URL. The deployed topology fronts both
 * the REST and WebSocket API Gateway APIs with one CloudFront distribution (see
 * services/cdk/src/web-stack.ts) so `https://<WebUrl>` is the one endpoint an operator needs;
 * appending `/ws` to the raw WebSocketUrl output instead produces a URL API Gateway does not
 * route. `allowApiGatewayEndpoint` exists only for an explicit `--ws` override, e.g. as a
 * deploy-day escape hatch if the CloudFront WebSocket hop misbehaves.
 */
export function resolveWsUrl(
  base: string,
  options: { allowApiGatewayEndpoint?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`invalid control-plane URL: ${base}`);
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (
    !options.allowApiGatewayEndpoint &&
    /\.execute-api\.[^.]+\.amazonaws\.com$/u.test(url.hostname)
  ) {
    throw new Error(
      `${base} is a raw API Gateway endpoint, not a host-reachable control-plane URL; ` +
        "use the CloudFront WebUrl from the deploy output instead, " +
        "e.g. HARNESS_API_URL=https://d111111abcdef8.cloudfront.net",
    );
  }
  if (url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url.toString();
}
