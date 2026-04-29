import { relayerFetch, submitTransaction, writeResult } from "./common.js";

async function runTrial(trialName: string, rpcUrls: string[]) {
  const networkId = process.env.RELAYER_NETWORK_ID ?? "evm:localhost-anvil";
  const patchResult = await relayerFetch(`/api/v1/networks/${networkId}`, {
    method: "PATCH",
    body: JSON.stringify({
      rpc_urls: rpcUrls.map((url, index) => ({
        url,
        weight: index === 0 ? 100 : 50,
      })),
    }),
  });

  const submissions: Array<{ ok: boolean; status?: string; error?: string }> = [];
  const runs = Number(process.env.FAILOVER_TRIAL_SUBMISSIONS ?? "20");

  for (let i = 0; i < runs; i += 1) {
    try {
      const tx = await submitTransaction({
        to: "0x000000000000000000000000000000000000dEaD",
        value: "1",
        data: "0x",
        gas_limit: 21_000,
        speed: "fast",
      });
      submissions.push({ ok: true, status: tx.status });
    } catch (error) {
      submissions.push({ ok: false, error: String(error) });
    }
  }

  const successCount = submissions.filter((s) => s.ok).length;
  const successRate = runs === 0 ? 0 : successCount / runs;

  return {
    trialName,
    rpcUrls,
    patchResult,
    runs,
    successCount,
    successRate,
    passes_threshold: successRate >= 0.95,
    submissions,
  };
}

async function main() {
  const dead = process.env.DEAD_RPC_URL ?? "http://127.0.0.1:59999";
  const valid = process.env.VALID_RPC_URL ?? "http://anvil:8545";

  const deadFirst = await runTrial("dead-first", [dead, valid]);
  const validFirst = await runTrial("valid-first", [valid, dead]);

  await writeResult("scenario4-rpc-failover.json", {
    threshold: "pass >= 95% successful submissions with one dead endpoint",
    deadFirst,
    validFirst,
  });

  console.log(
    `RPC failover complete deadFirst=${deadFirst.successRate.toFixed(2)} validFirst=${validFirst.successRate.toFixed(2)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
