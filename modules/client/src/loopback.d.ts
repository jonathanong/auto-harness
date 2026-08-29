/** True when `hostname` (as normalized by `URL#hostname`) is genuine loopback. */
export function isLoopbackHostname(hostname: string): boolean;

/** Loopback check for a `baseUrl` string; an unparseable URL is treated as non-loopback. */
export function isLoopbackOrigin(rawUrl: string): boolean;
