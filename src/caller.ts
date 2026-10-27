/**
 * Caller allow list.
 *
 * Workers Cache keys do not include `Origin` or `Referer`, so this check must
 * run in the gateway, which is never cached.
 */

/**
 * Check the caller against the host allow list.
 *
 * Both `Origin` and `Referer` are inspected: a `fetch()` from a page sends
 * `Origin`, while an `<img src>` only sends `Referer`. `example.com` matches
 * itself and its subdomains; `*.example.com` matches subdomains only.
 *
 * An empty list means the API is open to everybody.
 */
export function isAllowedCaller(
  request: Request,
  hosts: string[],
  allowEmpty: boolean,
): boolean {
  if (hosts.length === 0) return true;

  let sawHeader = false;
  for (const header of [
    request.headers.get("origin"),
    request.headers.get("referer"),
  ]) {
    if (!header) continue;
    sawHeader = true;

    let host: string;
    try {
      host = new URL(header).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host) continue;

    for (const domain of hosts) {
      if (host === domain) return true;
      // "*.example.com" matches any subdomain.
      if (domain.startsWith("*.") && host.endsWith(domain.slice(1))) return true;
      // "example.com" also matches its subdomains.
      if (host.endsWith(`.${domain}`)) return true;
    }
  }

  if (sawHeader) return false;
  return allowEmpty;
}
