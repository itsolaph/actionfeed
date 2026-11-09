import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class SsrfError extends Error {}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isBlockedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([b, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) >>> 0 === (v4ToInt(b) & mask) >>> 0;
    });
  }
  if (fam === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / NAT64 / embedded forms: judge by the embedded v4
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]!);
    const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === "::" || lower === "::1") return true;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith("2001:db8")) return true; // documentation
    return false;
  }
  return true; // not an IP: refuse
}

export interface UrlPolicy {
  production: boolean;
}

/** Syntactic checks only (scheme, credentials, literal IPs, obvious local names). DNS is checked at connect time. */
export function validateWebhookUrl(raw: string, policy: UrlPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("invalid url");
  }
  if (policy.production ? u.protocol !== "https:" : u.protocol !== "https:" && u.protocol !== "http:")
    throw new SsrfError("only https is allowed");
  if (u.username || u.password) throw new SsrfError("credentials in url not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfError("missing host");
  if (policy.production) {
    if (net.isIP(host) && isBlockedIp(host)) throw new SsrfError("blocked address");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
      throw new SsrfError("blocked host");
    if (u.port && !["443", "8443"].includes(u.port)) throw new SsrfError("port not allowed");
  }
  return u;
}

/**
 * DNS-rebinding-safe lookup: resolves and validates in the same step that supplies the address to connect(),
 * so there is no gap between "check" and "use".
 */
export function safeLookup(policy: UrlPolicy): net.LookupFunction {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return (cb as any)(err);
      const list = addrs as dns.LookupAddress[];
      if (policy.production) {
        for (const a of list) {
          if (isBlockedIp(a.address)) return (cb as any)(new SsrfError(`blocked address for ${hostname}`));
        }
      }
      const pick = list[0];
      if (!pick) return (cb as any)(new SsrfError("no address"));
      if ((options as any)?.all) return (cb as any)(null, list);
      (cb as any)(null, pick.address, pick.family);
    });
  };
}

export interface PostResult {
  status: number;
  body: string;
}

/** POST with no redirects, a hard timeout and a response-size cap. */
export function safePost(
  url: URL,
  body: string,
  headers: Record<string, string>,
  policy: UrlPolicy,
  timeoutMs = 8000,
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
        lookup: safeLookup(policy),
        timeout: timeoutMs,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          buf += c;
          if (buf.length > 4096) buf = buf.slice(0, 4096);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
