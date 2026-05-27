import type { Address, Hex } from "viem";
import { createPublicClient, defineChain, http } from "viem";
import { buildRunMacroCalldata } from "../tx/builder.js";
import { estimateTxFundingBreakdown, resolveMaxFeePerGas } from "./estimate-tx-funding.js";

const DEFAULT_REFERENCE_GAS_LIMIT = 200_000n;

/** Representative `runMacro` calldata for gas / fee estimation (not submitted). */
export function referenceRunMacroCalldata(_forwarderAddress: Address): Hex {
  const placeholder = "0x0000000000000000000000000000000000000001" as Address;
  const signature = `0x${"00".repeat(65)}` as Hex;
  return buildRunMacroCalldata({
    macro: placeholder,
    encodedPayload: "0x",
    signer: placeholder,
    signature,
  }) as Hex;
}

export type RelayFundingEstimate = {
  perTxWei: bigint;
  targetWei: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  l2Wei: bigint;
  l1Wei: bigint;
  feeModel: string;
};

export async function estimateRelayFundingTarget(input: {
  rpcUrl: string;
  chainId: number;
  forwarderAddress: Address;
  relayerSigner: Address;
  txCount: number;
  gasLimitOverride?: bigint;
  maxFeePerGasOverride?: bigint;
  perTxCostOverride?: bigint;
}): Promise<RelayFundingEstimate> {
  const {
    rpcUrl,
    chainId,
    forwarderAddress,
    relayerSigner,
    txCount,
    gasLimitOverride,
    maxFeePerGasOverride,
    perTxCostOverride,
  } = input;

  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const data = referenceRunMacroCalldata(forwarderAddress);

  const gasLimit = gasLimitOverride ?? DEFAULT_REFERENCE_GAS_LIMIT;

  const maxFeePerGas = await resolveMaxFeePerGas(client, maxFeePerGasOverride);

  const breakdown =
    perTxCostOverride === undefined
      ? await estimateTxFundingBreakdown({
          client,
          chainId,
          to: forwarderAddress,
          data,
          gasLimit,
          maxFeePerGas,
          nonce: await client.getTransactionCount({ address: relayerSigner }),
        })
      : {
          totalWei: perTxCostOverride,
          l2Wei: 0n,
          l1Wei: 0n,
          feeModel: "override" as const,
        };

  const perTxWei = perTxCostOverride ?? breakdown.totalWei;
  const targetWei = perTxWei * BigInt(txCount);
  return {
    perTxWei,
    targetWei,
    gasLimit,
    maxFeePerGas,
    l2Wei: breakdown.l2Wei,
    l1Wei: breakdown.l1Wei,
    feeModel: breakdown.feeModel,
  };
}
