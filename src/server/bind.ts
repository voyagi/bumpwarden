/** The value HOST takes when the server must accept connections on every interface. */
export const ALL_INTERFACES = 'all';

/**
 * Cloud Run requires the ingress container to listen on every interface and specifically not on
 * loopback, so the container image sets HOST to `all`. Node binds the unspecified address when
 * `listen` is given no hostname, and letting it pick keeps the service correct on an IPv6-only
 * host, which a hardcoded IPv4 wildcard would not be.
 */
export function bindHostname(host: string): string | undefined {
  return host === ALL_INTERFACES ? undefined : host;
}
