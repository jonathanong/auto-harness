function isLoopbackIpv4(hostname) {
  const octets = hostname.split(".");
  if (
    octets.length !== 4 ||
    !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  ) {
    return false;
  }
  return Number(octets[0]) === 127;
}

/**
 * True when `hostname` (as normalized by `URL#hostname`, e.g. lowercased, IPv6
 * bracketed as `[::1]`) can never leave the local machine's kernel: the IPv4
 * loopback block 127.0.0.0/8, the IPv6 loopback address `::1`, or `localhost`
 * (RFC 6761 §6.3 reserves this name to always resolve to loopback).
 *
 * RFC1918 private addresses and other custom hostnames are deliberately excluded:
 * they still cross real network hardware (switches, VPN, VPC peering) where
 * plaintext credentials can be sniffed, and trusting a caller's claim that a
 * hostname "resolves to loopback" would just reintroduce an unverified bypass.
 */
export function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || isLoopbackIpv4(hostname);
}

/** Loopback check for a `baseUrl` string; an unparseable URL is treated as non-loopback. */
export function isLoopbackOrigin(rawUrl) {
  try {
    return isLoopbackHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/** Throws when `apiKey` would travel over plain HTTP to a non-loopback `baseUrl`. */
export function assertSecureTransport(baseUrl, apiKey, allowInsecureHttp) {
  if (!apiKey || baseUrl.startsWith("https://")) return;
  if (allowInsecureHttp && isLoopbackOrigin(baseUrl)) return;
  throw new TypeError(
    "baseUrl must use https when apiKey is set (allowInsecureHttp only permits plain HTTP to a loopback baseUrl, e.g. http://127.0.0.1 or http://localhost)",
  );
}
