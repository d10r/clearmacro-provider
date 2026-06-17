import type { Address, Hex } from "viem";
import { createPublicClient, defineChain, http } from "viem";
import { buildRunMacroCalldata, buildRunPermit2AndMacroCalldata } from "../tx/builder.js";
import { estimateTxFundingBreakdown, resolveMaxFeePerGas } from "./estimate-tx-funding.js";

const DEFAULT_REFERENCE_GAS_LIMIT = 200_000n;

/** Representative `runMacro` calldata for gas / fee estimation (not submitted). */
export function referenceRunMacroCalldata(forwarderAddress: Address): Hex {
  const placeholder = forwarderAddress;
  const signature = `0x${"00".repeat(65)}` as Hex;
  return buildRunMacroCalldata({
    macro: placeholder,
    encodedPayload: "0x",
    signer: placeholder,
    signature,
  }) as Hex;
}

/**
 * Representative `runPermit2AndMacro` calldata for gas / fee estimation (not submitted).
 * Used for funding targets because production Permit2 rollout includes implied-upgrade,
 * which produces larger calldata than `runMacro`.
 */
export function referenceRunPermit2AndMacroCalldata(forwarderAddress: Address): Hex {
  const placeholder = forwarderAddress;
  const signature = `0x${"00".repeat(65)}` as Hex;
  return buildRunPermit2AndMacroCalldata({
    permit2Context: {
      permit: {
        permitted: {
          token: placeholder,
          amount: 1_000_000n,
        },
        nonce: 1n,
        deadline: 4_102_444_800n,
      },
      owner: placeholder,
      witness: `0x${"11".repeat(32)}`,
      witnessTypeString: "ClearMacro witness)Action(bytes32 salt)ClearMacro(address upgradeSuperToken,Action action,Security security)Security(string domain,address macroContract,string provider,uint256 validAfter,uint256 validBefore,uint256 nonce)TokenPermissions(address token,uint256 amount)",
      signature,
      spender: placeholder,
      upgradeSuperToken: placeholder,
    },
    macro: placeholder,
    encodedPayload: "0x",
  }) as Hex;
}

/** Conservative relay calldata reference for relayer funding estimates. */
export function referenceRelayCalldata(forwarderAddress: Address): Hex {
  const runMacro = referenceRunMacroCalldata(forwarderAddress);
  const runPermit2 = referenceRunPermit2AndMacroCalldata(forwarderAddress);
  return runPermit2.length >= runMacro.length ? runPermit2 : runMacro;
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
  const data = referenceRelayCalldata(forwarderAddress);

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
