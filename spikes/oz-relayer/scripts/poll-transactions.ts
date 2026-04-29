import { pollUntilTerminal, writeResult } from "./common.js";

async function main() {
  const ids = (process.env.TX_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error("TX_IDS must be provided as a comma-separated list");
  }

  const finalById = await pollUntilTerminal(ids, {
    timeoutMs: Number(process.env.POLL_TIMEOUT_MS ?? "180000"),
    pollMs: Number(process.env.POLL_INTERVAL_MS ?? "1000"),
  });

  await writeResult("polled-transactions.json", {
    txIds: ids,
    final: finalById,
  });
  console.log(`Polled ${ids.length} txs to terminal.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
