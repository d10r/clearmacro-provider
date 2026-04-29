import { relayerFetch, sendAnvilTransferFromRelayerTargetAddress, writeResult } from "./common.js";

async function main() {
  const tx = await sendAnvilTransferFromRelayerTargetAddress();

  const replaceResponse = await relayerFetch(
    `/api/v1/relayers/${process.env.RELAYER_ID ?? "anvil-relayer"}/transactions/${tx.id}`,
    {
      method: "PUT",
      body: JSON.stringify({
        to: "0x000000000000000000000000000000000000dEaD",
        value: "1",
        data: "0x",
        gas_limit: 21_000,
        speed: "fast",
      }),
    },
  );

  const cancelResponse = await relayerFetch(
    `/api/v1/relayers/${process.env.RELAYER_ID ?? "anvil-relayer"}/transactions/${tx.id}`,
    {
      method: "DELETE",
    },
  );

  const deletePendingResponse = await relayerFetch(
    `/api/v1/relayers/${process.env.RELAYER_ID ?? "anvil-relayer"}/transactions/pending`,
    {
      method: "DELETE",
    },
  );

  await writeResult("scenario5-replacement-cancel.json", {
    tx,
    replaceResponse,
    cancelResponse,
    deletePendingResponse,
  });

  console.log(`Replacement/cancel scenario captured for tx=${tx.id}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
