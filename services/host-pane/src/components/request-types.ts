/** Same-origin request boundary used by host-pane inventory components. */
export type RequestFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
