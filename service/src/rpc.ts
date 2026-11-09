import { createPublicClient, http, type PublicClient, type Log, type Address } from "viem";
import { base } from "viem/chains";
import { ALL_EVENTS } from "./abi.js";

export const DEFAULT_RPC = "https://base-rpc.publicnode.com";

export function makeClient(url = process.env.RPC_URL || DEFAULT_RPC): PublicClient {
  return createPublicClient({
    chain: base,
    transport: http(url, { retryCount: 4, retryDelay: 400, timeout: 20_000 }),
  }) as PublicClient;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withBackoff<T>(fn: () => Promise<T>, tries = 6, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(baseMs * 2 ** i + Math.random() * 200);
    }
  }
  throw last;
}

export interface LogFetchOptions {
  chunk?: number;
  addressBatch?: number;
  onProgress?: (from: bigint, to: bigint) => void;
}

/**
 * getLogs over [from,to] in small block chunks, filtered by address list (batched) and our event set.
 * A chunk that errors is halved (public RPCs reject big ranges) down to 1 block before giving up.
 */
export async function fetchLogs(
  client: PublicClient,
  addresses: Address[],
  from: bigint,
  to: bigint,
  opts: LogFetchOptions = {},
): Promise<Log[]> {
  const out: Log[] = [];
  let chunk = BigInt(opts.chunk ?? 2000);
  // publicnode rejects getLogs with more than ~10 addresses ("Invalid parameters"), so keep batches small.
  const batch = opts.addressBatch ?? Number(process.env.ADDRESS_BATCH || 10);
  let cursor = from;
  while (cursor <= to) {
    const end = cursor + chunk - 1n > to ? to : cursor + chunk - 1n;
    try {
      const batches: Address[][] = [];
      for (let i = 0; i < addresses.length; i += batch) batches.push(addresses.slice(i, i + batch));
      const conc = Number(process.env.RPC_CONCURRENCY || 6);
      for (let i = 0; i < batches.length; i += conc) {
        const results = await Promise.all(
          batches.slice(i, i + conc).map((a) =>
            withBackoff(() => client.getLogs({ address: a, events: ALL_EVENTS, fromBlock: cursor, toBlock: end }), 3),
          ),
        );
        for (const logs of results) out.push(...(logs as Log[]));
      }
      opts.onProgress?.(cursor, end);
      cursor = end + 1n;
      if (chunk < BigInt(opts.chunk ?? 2000)) chunk = chunk * 2n; // recover gradually
    } catch (e) {
      if (chunk <= 1n) throw e;
      chunk = chunk / 2n;
    }
  }
  return out;
}
