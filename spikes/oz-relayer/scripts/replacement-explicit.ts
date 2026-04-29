import {
  getTransaction,
  relayerFetch,
  RELAYER_ID,
  sleep,
  submitTransaction,
  writeResult,
} from "./common.js";

type MaybeTx = {
  id: string;
  status: string;
  gas_price?: string | number | null;
  max_fee_per_gas?: string | number | null;
  max_priority_fee_per_gas?: string | number | null;
  nonce?: number | null;
  to?: string;
  value?: string;
  data?: string;
  gas_limit?: number;
};

function bump(value: bigint): bigint {
  const byPercent = (value * 120n) / 100n;
  return byPercent > value ? byPercent : value + 1n;
}

async function waitForSubmittedWithPrice(txId: string, timeoutMs = 60_000): Promise<MaybeTx> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx = (await getTransaction(txId)) as MaybeTx;
    const hasLegacyPrice = tx.gas_price != null;
    const has1559Price = tx.max_fee_per_gas != null && tx.max_priority_fee_per_gas != null;
    if ((tx.status === "sent" || tx.status === "submitted") && (hasLegacyPrice || has1559Price)) {
      return tx;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for submitted tx with prices: ${txId}`);
}

async function main() {
  const baseRequest = {
    to: "0x000000000000000000000000000000000000dEaD",
    value: "1",
    data: "0x",
    gas_limit: 21_000,
    speed: "fast",
  };

  const original = await submitTransaction(baseRequest);
  const submitted = await waitForSubmittedWithPrice(original.id);

  const replacementPayload: Record<string, unknown> = {
    to: submitted.to ?? baseRequest.to,
    value: submitted.value ?? baseRequest.value,
    data: submitted.data ?? baseRequest.data,
    gas_limit: submitted.gas_limit ?? baseRequest.gas_limit,
  };

  if (submitted.gas_price != null) {
    replacementPayload.gas_price = Number(bump(BigInt(submitted.gas_price.toString())));
  } else if (
    submitted.max_fee_per_gas != null &&
    submitted.max_priority_fee_per_gas != null
  ) {
    replacementPayload.max_fee_per_gas = Number(bump(BigInt(submitted.max_fee_per_gas.toString())));
    replacementPayload.max_priority_fee_per_gas = Number(
      bump(BigInt(submitted.max_priority_fee_per_gas.toString())),
    );
  } else {
    throw new Error("No price fields available for explicit replacement");
  }

  const replaceResponse = await relayerFetch(
    `/api/v1/relayers/${RELAYER_ID}/transactions/${original.id}`,
    {
      method: "PUT",
      body: JSON.stringify(replacementPayload),
    },
  );

  let postReplaceOldTx: unknown;
  try {
    postReplaceOldTx = await getTransaction(original.id);
  } catch (error) {
    postReplaceOldTx = { error: String(error) };
  }

  const maybeReplacementId =
    typeof replaceResponse.data === "object" && replaceResponse.data !== null
      ? (replaceResponse.data as { id?: string }).id
      : undefined;

  let replacementTx: unknown = null;
  if (maybeReplacementId) {
    try {
      replacementTx = await getTransaction(maybeReplacementId);
    } catch (error) {
      replacementTx = { error: String(error) };
    }
  }

  await writeResult("scenario5b-replacement-explicit.json", {
    originalSubmission: original,
    submittedState: submitted,
    replacementPayload,
    replaceResponse,
    postReplaceOldTx,
    replacementTx,
  });

  console.log(
    `Explicit replacement attempted for ${original.id} -> status ${replaceResponse.status}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
