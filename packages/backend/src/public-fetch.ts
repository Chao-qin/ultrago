/**
 * GET a URL that an agent or a book supplied, refusing anything that is not
 * on the public internet.
 *
 * Checking the host before calling `fetch` is not enough, for two reasons:
 * `fetch` follows redirects to hosts nobody checked, and it resolves the name
 * again when it connects, so a short-TTL DNS answer can name a public address
 * for the check and a private one for the connection. Here the check runs where
 * the connection is made — inside the socket's `lookup` — on the exact address
 * the socket will use, and redirects are followed by hand so every hop takes
 * the same path. A refused address never gets a connection.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { domainAllowed } from "./config.js";

/** IANA special-purpose ranges: loopback, private, link-local, shared (CGNAT),
 *  benchmarking, documentation, multicast, reserved — nothing a public file
 *  host lives on. */
const SPECIAL_PURPOSE = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    // ::/96 covers ::, ::1 and the deprecated IPv4-compatible form; fec0::/10 is deprecated site-local.
    ["::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
    ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ] as const) list.addSubnet(net, prefix, "ipv6");
  return list;
})();

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail included). */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const parse = (part: string | undefined) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  return tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

/** The IPv4 address an IPv6 one carries, for every form that routes to it:
 *  IPv4-mapped `::ffff:a.b.c.d`, IPv4-translated (SIIT) `::ffff:0:a.b.c.d`,
 *  the NAT64 well-known prefix `64:ff9b::a.b.c.d`, and 6to4 `2002:AABB:CCDD::`. */
function embeddedIpv4(g: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/** True for an address no public URL may reach. An IPv6 address that carries
 *  an IPv4 one is judged as that IPv4 address. */
export function isSpecialPurposeAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return SPECIAL_PURPOSE.check(ip, "ipv4");
  if (family !== 6) return true;
  const carried = embeddedIpv4(v6Groups(ip));
  if (carried) return SPECIAL_PURPOSE.check(carried, "ipv4");
  return SPECIAL_PURPOSE.check(ip, "ipv6");
}

export interface PublicFetchDeps {
  /** Resolve a host name to every address it has. Default: the system resolver. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Which resolved addresses to refuse. Default: isSpecialPurposeAddress. */
  isBlockedAddress?: (ip: string) => boolean;
}

export interface PublicFetchOptions {
  /** Request headers for each hop, given that hop's URL (a Referer, say, belongs to the host it is sent to). */
  headers?: (url: URL) => Record<string, string>;
  /** Budget for the whole request, redirects included. */
  timeoutMs: number;
  /** Refuse a body larger than this many bytes (checked as it streams). */
  maxBytes: number;
  maxRedirects?: number;
}

export interface PublicFetchResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** The URL that finally answered, after redirects. */
  url: string;
  body: Buffer;
}

/** Thrown for a URL this module refuses to reach (not retryable). */
export class PublicUrlRefused extends Error {}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export async function fetchPublicUrl(rawUrl: string, opts: PublicFetchOptions, deps: PublicFetchDeps = {}): Promise<PublicFetchResponse> {
  const resolveAll = deps.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  const blocked = deps.isBlockedAddress ?? isSpecialPurposeAddress;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const maxRedirects = opts.maxRedirects ?? 5;

  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    const target = checkUrl(url, blocked);
    const res = await get(target, opts.headers?.(target) ?? {}, signal, guardedLookup(resolveAll, blocked));
    const location = res.headers.location;
    if (REDIRECT.has(res.statusCode ?? 0) && location) {
      res.resume();
      if (hop >= maxRedirects) throw new PublicUrlRefused(`too many redirects (more than ${maxRedirects}) starting at ${rawUrl}`);
      url = new URL(location, target).href;
      continue;
    }
    const status = res.statusCode ?? 0;
    // Only a 2xx body is content; an error page is not read, so its size can
    // never hide the status behind a "too large".
    if (status < 200 || status >= 300) {
      res.resume();
      return { status, headers: res.headers, url, body: Buffer.alloc(0) };
    }
    return { status, headers: res.headers, url, body: await readBody(res, opts.maxBytes) };
  }
}

/** Everything that can be judged from the URL alone, for every hop. */
function checkUrl(raw: string, blocked: (ip: string) => boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PublicUrlRefused(`${raw}: must be an absolute http(s) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new PublicUrlRefused(`${raw}: only http(s) URLs are allowed`);
  const policy = domainAllowed(u.href);
  if (!policy.ok) throw new PublicUrlRefused(`${raw}: ${policy.reason}`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new PublicUrlRefused(`${raw}: refusing to fetch a loopback address`);
  // A literal address never reaches `lookup`, so it is judged here.
  if (isIP(host) && blocked(host)) throw new PublicUrlRefused(`${raw}: refusing to fetch a private, loopback or reserved address`);
  return u;
}

/** The socket's own name resolution, refusing the connection when any address
 *  the name resolves to is not public (a mixed answer is how rebinding hides). */
function guardedLookup(
  resolveAll: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
  blocked: (ip: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname).then(
      (addresses) => {
        const bad = addresses.find((a) => blocked(a.address));
        if (!addresses.length || bad) {
          const err = new PublicUrlRefused(
            bad ? `${hostname} resolves to ${bad.address}, a private, loopback or reserved address — refusing to connect` : `${hostname} did not resolve`,
          );
          callback(err as NodeJS.ErrnoException, "", 0);
          return;
        }
        if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, "", 0),
    );
  };
}

function get(u: URL, headers: Record<string, string>, signal: AbortSignal, lookup: LookupFunction): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(u, { method: "GET", headers, signal, lookup }, resolve);
    req.on("error", reject);
    req.end();
  });
}

function readBody(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers["content-length"] || 0);
    if (declared > maxBytes) {
      res.destroy();
      reject(new PublicUrlRefused(`file too large (${declared}B > ${maxBytes}B cap)`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        reject(new PublicUrlRefused(`file too large (more than ${maxBytes}B cap)`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}
