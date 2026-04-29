import {
  lifecycleMap,
  pollUntilTerminal,
  sendAnvilTransferFromRelayerTargetAddress,
  SPIKE_RULES,
  writeResult,
} from "./common.js";

async function main() {
  const count = Number(process.env.BURST_COUNT ?? "20");
  const submissions: Array<Record<string, unknown>> = [];
  const acceptedIds: string[] = [];
  const submitErrors: Array<Record<string, unknown>> = [];

  for (let i = 0; i < count; i += 1) {
    try {
      const tx = await sendAnvilTransferFromRelayerTargetAddress();
      acceptedIds.push(tx.id);
      submissions.push({
        order: i,
        id: tx.id,
        hash: tx.hash ?? null,
        nonce: tx.nonce ?? null,
        status: tx.status,
      });
    } catch (error) {
      submitErrors.push({ order: i, error: String(error) });
    }
  }

  const finalById = acceptedIds.length > 0 ? await pollUntilTerminal(acceptedIds) : {};
  const final = Object.values(finalById).map((tx) => ({
    ...tx,
    lifecycle_state: lifecycleMap(tx.status, tx),
  }));

  const nonceValues = final.map((tx) => tx.nonce).filter((v): v is number => Number.isInteger(v));
  const uniqueNonceCount = new Set(nonceValues).size;
  const hasDuplicateNonces = uniqueNonceCount !== nonceValues.length;

  await writeResult("scenario1-burst-submission.json", {
    rules: SPIKE_RULES.nonceValidity,
    count,
    accepted: acceptedIds.length,
    submit_failed: submitErrors.length,
    has_duplicate_nonces: hasDuplicateNonces,
    submit_errors: submitErrors,
    submissions,
    final,
  });

  console.log(`Burst submitted=${acceptedIds.length} failed=${submitErrors.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
