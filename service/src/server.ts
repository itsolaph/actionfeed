import { EventEmitter } from "node:events";
import { getAddress, type Address } from "viem";
import { tokenAbi } from "./abi.js";
import { buildApp } from "./app.js";
import { Db } from "./db.js";
import { fetchTokenList, syncOnce } from "./indexer.js";
import { keeperConfigFromEnv, runKeeperOnce } from "./keeper.js";
import { makeClient, sleep } from "./rpc.js";
import { Webhooks } from "./webhooks.js";

const env = process.env;
const production = env.NODE_ENV === "production";
const db = new Db(env.DB_PATH || "actionfeed.sqlite");
const client = makeClient();
const bus = new EventEmitter();
const webhooks = new Webhooks(db, { production });
const startBlock = BigInt(env.START_BLOCK || "0");
const confirmations = BigInt(env.CONFIRMATIONS || "20");

async function discover() {
  for (const t of await fetchTokenList()) db.upsertToken(t);
}

async function loop() {
  await discover().catch((e) => console.error("[discover]", e.message));
  for (;;) {
    try {
      const r = await syncOnce(client, db, {
        startBlock,
        confirmations,
        onNewEvent: (row) => {
          bus.emit("event", row);
          webhooks.onChainEvent(row);
        },
      });
      if (r.inserted) console.log(`[indexer] ${r.from}-${r.to}: +${r.inserted} events`);
    } catch (e) {
      console.error("[indexer]", (e as Error).message);
    }
    webhooks.scanSchedule();
    await webhooks.processQueue();
    const kc = keeperConfigFromEnv();
    if (kc) {
      await runKeeperOnce(kc, client, db.tokens().map((t) => getAddress(t.address) as Address)).catch((e) => console.error("[keeper]", e.message));
    }
    await sleep(Number(env.POLL_MS || 15_000));
  }
}

const app = await buildApp({
  db,
  webhooks,
  bus,
  production,
  live: async (address) => {
    const a = getAddress(address);
    const [m, n, e] = await Promise.all([
      client.readContract({ address: a, abi: tokenAbi, functionName: "uiMultiplier" }),
      client.readContract({ address: a, abi: tokenAbi, functionName: "newUIMultiplier" }),
      client.readContract({ address: a, abi: tokenAbi, functionName: "effectiveAt" }),
    ]);
    return { uiMultiplier: m.toString(), newUIMultiplier: n.toString(), effectiveAt: Number(e) };
  },
});
await app.listen({ port: Number(env.PORT || 8787), host: env.HOST || "0.0.0.0" });
console.log("ActionFeed service listening");
void loop();
