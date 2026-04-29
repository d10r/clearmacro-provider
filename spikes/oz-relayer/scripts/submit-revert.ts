import {
  deployAlwaysRevertContract,
  getTransaction,
  pollUntilTerminal,
  submitTransaction,
  writeResult,
} from "./common.js";

async function main() {
  const contractAddress = process.env.REVERT_CONTRACT_ADDRESS
    ? (process.env.REVERT_CONTRACT_ADDRESS as `0x${string}`)
    : await deployAlwaysRevertContract();

  const submitted = await submitTransaction({
    to: contractAddress,
    value: "0",
    data: "0x12345678",
    gas_limit: 120_000,
    speed: "fast",
  });

  const polled = await pollUntilTerminal([submitted.id], { timeoutMs: 120_000, pollMs: 1_000 });
  const finalTx = polled[submitted.id] ?? (await getTransaction(submitted.id));

  await writeResult("scenario2-revert-handling.json", {
    contractAddress,
    submitted,
    final: finalTx,
  });

  console.log(`Revert scenario complete. tx=${submitted.id} status=${finalTx.status}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
