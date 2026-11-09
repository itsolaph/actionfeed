import { describe, expect, it } from "vitest";
import { isBlockedIp, validateWebhookUrl, SsrfError } from "../src/ssrf.js";
import { sign, verify } from "../src/signing.js";
import { appendSuffix, builderSuffix, parseSuffix } from "../src/builder.js";

describe("ssrf", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"])(
    "blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  const prod = { production: true };
  it("production: https only, no creds, no private literals", () => {
    expect(() => validateWebhookUrl("http://example.com/h", prod)).toThrow(SsrfError);
    expect(() => validateWebhookUrl("https://user:pw@example.com/h", prod)).toThrow(SsrfError);
    expect(() => validateWebhookUrl("https://127.0.0.1/h", prod)).toThrow(SsrfError);
    expect(() => validateWebhookUrl("https://[::1]/h", prod)).toThrow(SsrfError);
    expect(() => validateWebhookUrl("https://localhost/h", prod)).toThrow(SsrfError);
    expect(() => validateWebhookUrl("https://example.com:6379/h", prod)).toThrow(SsrfError);
    expect(() => validateWebhookUrl("ftp://example.com/h", prod)).toThrow(SsrfError);
    expect(validateWebhookUrl("https://example.com/h", prod).hostname).toBe("example.com");
  });
  it("dev mode allows http", () => {
    expect(validateWebhookUrl("http://localhost:9999/h", { production: false }).port).toBe("9999");
  });
});

describe("signature", () => {
  const body = JSON.stringify({ a: 1 });
  it("round-trips", () => expect(verify("s", body, sign("s", body, 1000), 300, 1100)).toBe(true));
  it("rejects wrong secret / tampered body / stale / malformed", () => {
    const h = sign("s", body, 1000);
    expect(verify("x", body, h, 300, 1000)).toBe(false);
    expect(verify("s", body + " ", h, 300, 1000)).toBe(false);
    expect(verify("s", body, h, 300, 1301)).toBe(false);
    expect(verify("s", body, "garbage", 300, 1000)).toBe(false);
    expect(verify("s", body, "t=1000,v1=zz", 300, 1000)).toBe(false);
  });
});

describe("ERC-8021 suffix", () => {
  it("matches the spec example", () => {
    expect(appendSuffix("0xdddddddd", builderSuffix("baseapp"))).toBe(
      "0xdddddddd62617365617070070080218021802180218021802180218021",
    );
  });
  it("multi code and parse", () => {
    const s = builderSuffix(["baseapp", "morpho"]);
    expect(parseSuffix(appendSuffix("0x1234", s))).toEqual({ codes: ["baseapp", "morpho"] });
    expect(parseSuffix("0x1234")).toBeNull();
  });
  it("rejects bad codes", () => {
    expect(() => builderSuffix("a,b")).toThrow();
    expect(() => builderSuffix("")).toThrow();
  });
});
