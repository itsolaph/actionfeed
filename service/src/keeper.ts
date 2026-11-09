import { readFileSync } from "node:fs";
import { encodeFunctionData, createWalletClient, http, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { actionFeedAbi, tokenAbi } from "./abi.js";
import { appendSuffix, builderSuffix } from "./builder.js";

export interface KeeperConfig {
  contract: Address;
  keyFile?: string; // KEEPER_KEY_FILE: path to a file containing the hex private key; read at runtime only
  builderCode?: string; // BUILDER_CODE
  dryRun: boolean; // default true
  maxGasPriceGwei: number;
  maxGasLimit: bigint;
  rpcUrl?: string;
}

export function keeperConfigFromEnv(env = process.env): KeeperConfig | null {
  if (!env.KEEPER_KEY_FILE || !env.ACTIONFEED_ADDRESS) return null;
  return {
    contract: getAddress(env.ACTIONFEED_ADDRESS),
    keyFile: env.KEEPER_KEY_FILE,
    builderCode: env.BUILDER_CODE,
    dryRun: env.KEEPER_DRY_RUN !== "0", // dry-run ON unless explicitly "0"
    maxGasPriceGwei: Number(env.KEEPER_MAX_GWEI ?? "1"),
    maxGasLimit: BigInt(env.KEEPER_MAX_GAS ?? "1500000"),
    rpcUrl: env.RPC_URL,
  };
}

/** Which tokens have a matured multiplier that is not yet checkpointed? */
export async function tokensNeedingCheckpoint(client: PublicClient, feed: Address, tokens: Address[]): Promise<Address[]> {
  const out: Address[] = [];
  for (const t of tokens) {
    try {
      const [m, rec] = await Promise.all([
        client.readContract({ address: t, abi: tokenAbi, functionName: "uiMultiplier" }),
        client.readContract({ address: feed, abi: actionFeedAbi, functionName: "multiplierAt", args: [t, BigInt(Math.floor(Date.now() / 1000))] }),
      ]);
      if (!rec[1] || rec[0] !== m) out.push(t);
    } catch {
      /* skip tokens that fail to read */
    }
  }
  return out;
}

export function buildCheckpointCalldata(tokens: Address[], builderCode?: string): Hex {
  const data = encodeFunctionData({ abi: actionFeedAbi, functionName: "checkpointMany", args: [tokens] });
  return builderCode ? appendSuffix(data, builderSuffix(builderCode)) : data;
}

export async function runKeeperOnce(cfg: KeeperConfig, client: PublicClient, tokens: Address[], log = console.log) {
  const due = await tokensNeedingCheckpoint(client, cfg.contract, tokens);
  if (due.length === 0) return { sent: false, due };
  const data = buildCheckpointCalldata(due, cfg.builderCode);
  const gasPrice = await client.getGasPrice();
  if (Number(gasPrice) / 1e9 > cfg.maxGasPriceGwei) {
    log(`[keeper] gas price above cap, skipping`);
    return { sent: false, due, reason: "gas-cap" };
  }
  const gas = await client.estimateGas({ to: cfg.contract, data, account: "0x0000000000000000000000000000000000000001" }).catch(() => cfg.maxGasLimit);
  if (gas > cfg.maxGasLimit) return { sent: false, due, reason: "gas-limit" };
  if (cfg.dryRun || !cfg.keyFile) {
    log(`[keeper] dry-run: would checkpoint ${due.length} token(s), gas~${gas}`);
    return { sent: false, due, dryRun: true, data };
  }
  const key = readFileSync(cfg.keyFile, "utf8").trim() as Hex; // never logged
  const account = privateKeyToAccount(key.startsWith("0x") ? key : (`0x${key}` as Hex));
  const wallet = createWalletClient({ account, chain: base, transport: http(cfg.rpcUrl) });
  const hash = await wallet.sendTransaction({ to: cfg.contract, data, gas: (gas * 12n) / 10n > cfg.maxGasLimit ? cfg.maxGasLimit : (gas * 12n) / 10n });
  log(`[keeper] sent ${hash}`);
  return { sent: true, due, hash };
}
