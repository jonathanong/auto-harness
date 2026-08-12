/** Same-origin request boundary used by catalog action components. */
export type RequestFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
