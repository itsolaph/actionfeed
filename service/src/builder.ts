/**
 * ERC-8021 / Base Builder Code attribution, Schema 0.
 * Layout appended to calldata:  codes || codesLength(1 byte) || schemaId(0x00) || marker(16 bytes, 0x8021 x8)
 * Codes are ASCII, comma separated. Spec: https://eip.tools/eip/8021 ; Base docs: docs.base.org/specifications/builder-codes
 */
import type { Hex } from "viem";

export const ERC8021_MARKER = "80218021802180218021802180218021";

export function builderSuffix(codes: string | string[]): Hex {
  const list = (Array.isArray(codes) ? codes : [codes]).map((c) => c.trim()).filter(Boolean);
  if (list.length === 0) throw new Error("no builder code");
  for (const c of list) {
    if (!/^[\x21-\x7e]+$/.test(c) || c.includes(",")) throw new Error("builder code must be printable ASCII without commas");
  }
  const joined = Buffer.from(list.join(","), "ascii");
  if (joined.length > 255) throw new Error("builder codes too long");
  return `0x${joined.toString("hex")}${joined.length.toString(16).padStart(2, "0")}00${ERC8021_MARKER}` as Hex;
}

export function appendSuffix(calldata: Hex, suffix: Hex): Hex {
  return (calldata + suffix.slice(2)) as Hex;
}

/** Parse a Schema 0 suffix off the end of calldata, or null if absent. */
export function parseSuffix(data: Hex): { codes: string[] } | null {
  const h = data.slice(2).toLowerCase();
  if (!h.endsWith(ERC8021_MARKER) || h.length < 2 * (16 + 2)) return null;
  const body = h.slice(0, -32);
  if (body.slice(-2) !== "00") return null;
  const len = parseInt(body.slice(-4, -2), 16);
  const codesHex = body.slice(-4 - 2 * len, -4);
  if (codesHex.length !== 2 * len) return null;
  return { codes: Buffer.from(codesHex, "hex").toString("ascii").split(",") };
}
