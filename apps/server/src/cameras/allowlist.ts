import { BlockList, isIP } from 'node:net';

/**
 * The camera proxy's allowlist (`proxy.allowlist` in the config file). Each entry names one place the server
 * may fetch camera media from:
 *
 *   cams.example.com        that host, on the scheme's own port (80 for http, 443 for https)
 *   cams.example.com:8080   that host, on that port only
 *   *.cdn.example.com       any host below that name (not the name itself), on the scheme's own port
 *   192.168.1.20:8080       an address; this is how a camera on your own network is allowed
 *
 * Anything not listed is refused, which is what keeps the proxy from being usable as an open proxy.
 */
export interface HostRule {
  /** The entry as written, for messages. */
  entry: string;
  /** Lower-case host name or address, without the `*.` of a wildcard and without IPv6 brackets. */
  host: string;
  wildcard: boolean;
  /** Null: the default port of the scheme. */
  port: number | null;
  /** The entry is a literal address rather than a name. */
  isAddress: boolean;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Parses one allowlist entry. Throws with a message meant for the person editing the config file. */
export function parseHostRule(raw: string): HostRule {
  const entry = raw.trim().toLowerCase();
  const fail = (why: string): never => {
    throw new Error(`"${raw}" is not a valid allowlist entry: ${why}`);
  };
  if (entry === '') fail('it is empty');
  if (/[\s/?#@]/.test(entry) || entry.includes('://')) {
    fail('write a host name or address with an optional port, not a URL');
  }

  let host = entry;
  let port: number | null = null;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry);
  if (bracketed) {
    host = bracketed[1] as string;
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
    if (isIP(host) !== 6) fail('the part in brackets is not an IPv6 address');
  } else if (isIP(entry) !== 6) {
    const withPort = /^(.*):(\d{1,5})$/.exec(entry);
    if (withPort) {
      host = withPort[1] as string;
      port = Number(withPort[2]);
    } else if (entry.includes(':')) {
      fail('the port must be a number');
    }
  }
  if (port !== null && (port < 1 || port > 65535)) fail('the port must be between 1 and 65535');

  if (isIP(host) !== 0) return { entry: raw, host, wildcard: false, port, isAddress: true };

  let wildcard = false;
  if (host.startsWith('*.')) {
    wildcard = true;
    host = host.slice(2);
  }
  if (host.includes('*')) fail('"*" may only stand for the first part of a name, as in *.example.com');
  const labels = host.split('.');
  if (host.length > 253 || labels.some((label) => !LABEL.test(label))) fail('the host name is malformed');
  // `*.com` would allow most of the internet.
  if (wildcard && labels.length < 2)
    fail('a wildcard needs at least a domain and a top-level domain after it');
  // A name made of digits and dots that is not an address is a typo, not a host.
  if (/^[\d.]+$/.test(host)) fail('that looks like an incomplete address');
  return { entry: raw, host, wildcard, port, isAddress: false };
}

/** Parses the whole list; the error names the entry that is wrong. */
export function parseAllowlist(entries: readonly string[]): HostRule[] {
  return entries.map(parseHostRule);
}

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** The rule that allows this URL, or null when none does. Only http and https can be allowed at all. */
export function matchRule(url: URL, rules: readonly HostRule[]): HostRule | null {
  const defaultPort = DEFAULT_PORT[url.protocol];
  if (defaultPort === undefined) return null;
  const port = url.port === '' ? defaultPort : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostIsAddress = isIP(host) !== 0;
  for (const rule of rules) {
    if ((rule.port ?? defaultPort) !== port) continue;
    if (rule.isAddress !== hostIsAddress) continue;
    if (rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host) return rule;
  }
  return null;
}

/** Everything that is not a public unicast address: loopback, private, link-local, shared, reserved. */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/**
 * Whether an address is on the public internet. A name on the allowlist that resolves to anything else is
 * refused unless `proxy.allowPrivateAddresses` is on: otherwise an outside host could point its name at a
 * device on your network and have the server fetch from it.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4');
  if (family !== 6) return false;
  // One spelling per address: the URL parser writes IPv6 in its shortest hexadecimal form.
  const canonical = new URL(`http://[${address.replace(/%.*$/, '')}]/`).hostname.slice(1, -1);
  // An IPv4 address carried inside IPv6 (::ffff:10.0.0.1, or the NAT64 prefix) is judged as that IPv4 address.
  const embedded = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (embedded) {
    const high = Number.parseInt(embedded[1] as string, 16);
    const low = Number.parseInt(embedded[2] as string, 16);
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return !NON_PUBLIC.check(canonical, 'ipv6');
}
