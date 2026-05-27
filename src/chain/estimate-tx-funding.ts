/**
 * Relay / contract tx funding estimate:
 * - Scroll: L1GasPriceOracle at 0x5300…0002
 * - OP Stack: GasPriceOracle at 0x4200…000F (getL1Fee + L2 execution fee)
 * - Otherwise: gasLimit × maxFeePerGas (L1-style chains)
 */
import type { Address, Hex, PublicClient } from "viem";
import { serializeTransaction } from "viem";

const FUNDING_BUFFER_BPS = 1000n;
const SCROLL_CHAIN_IDS = new Set([534351, 534352]);
const OP_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F" as Address;
const SCROLL_L1_GAS_ORACLE = "0x5300000000000000000000000000000000000002" as Address;

const GAS_PRICE_ORACLE_PROBE_ABI = [
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

const L1_FEE_ORACLE_ABI = [
  {
    type: "function",
    name: "getL1Fee",
    stateMutability: "view",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type TxParams = {
  chainId: number;
  to: Address;
  data: Hex;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  nonce: number;
};

function withBuffer(amount: bigint): bigint {
  return (amount * (10000n + FUNDING_BUFFER_BPS)) / 10000n;
}

function executionFee(gasLimit: bigint, maxFeePerGas: bigint): bigint {
  return gasLimit * maxFeePerGas;
}

function chainDeclaresOpStack(chain: PublicClient["chain"]): boolean {
  const contracts = chain?.contracts as Record<string, { address?: Address }> | undefined;
  return Boolean(contracts?.gasPriceOracle?.address);
}

async function hasOpGasPriceOracle(client: PublicClient): Promise<boolean> {
  if (chainDeclaresOpStack(client.chain)) return true;
  try {
    await client.readContract({
      address: OP_GAS_PRICE_ORACLE,
      abi: GAS_PRICE_ORACLE_PROBE_ABI,
      functionName: "version",
    });
    return true;
  } catch {
    return false;
  }
}

async function l1DataFee(client: PublicClient, oracle: Address, params: TxParams): Promise<bigint> {
  const serialized = serializeTransaction({
    chainId: params.chainId,
    to: params.to,
    data: params.data,
    gas: params.gasLimit,
    maxFeePerGas: params.maxFeePerGas,
    maxPriorityFeePerGas: params.maxFeePerGas,
    nonce: params.nonce,
    type: "eip1559",
  });

  return client.readContract({
    address: oracle,
    abi: L1_FEE_ORACLE_ABI,
    functionName: "getL1Fee",
    args: [serialized],
  });
}

export type TxFundingBreakdown = {
  totalWei: bigint;
  l2Wei: bigint;
  l1Wei: bigint;
  feeModel: "op-stack" | "scroll" | "execution-only";
};

/** Conservative max fee: cap EIP-1559 spikes far above current gas price (common on Polygon). */
export async function resolveMaxFeePerGas(client: PublicClient, override?: bigint): Promise<bigint> {
  if (override !== undefined) return override;
  const gasPrice = await client.getGasPrice();
  const fees = await client.estimateFeesPerGas();
  let maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? gasPrice;
  if (maxFee > gasPrice * 3n) {
    maxFee = gasPrice * 2n;
  }
  return maxFee;
}

/** Total wei for one reference tx (+10% buffer), with L1/L2 split. */
export async function estimateTxFundingBreakdown(params: {
  client: PublicClient;
  chainId: number;
  to: Address;
  data: Hex;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  nonce?: number;
}): Promise<TxFundingBreakdown> {
  const { client, chainId, to, data, gasLimit, maxFeePerGas, nonce = 0 } = params;
  const txParams: TxParams = { chainId, to, data, gasLimit, maxFeePerGas, nonce };
  const l2Wei = executionFee(gasLimit, maxFeePerGas);

  if (SCROLL_CHAIN_IDS.has(chainId)) {
    let l1Wei: bigint;
    try {
      l1Wei = await l1DataFee(client, SCROLL_L1_GAS_ORACLE, txParams);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`Cannot estimate scroll L1 data fee on chain ${chainId}: ${detail}`);
    }
    return { l2Wei, l1Wei, totalWei: withBuffer(l1Wei + l2Wei), feeModel: "scroll" };
  }

  if (await hasOpGasPriceOracle(client)) {
    let l1Wei: bigint;
    try {
      l1Wei = await l1DataFee(client, OP_GAS_PRICE_ORACLE, txParams);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`Cannot estimate OP Stack L1 data fee on chain ${chainId}: ${detail}`);
    }
    return { l2Wei, l1Wei, totalWei: withBuffer(l1Wei + l2Wei), feeModel: "op-stack" };
  }

  return { l2Wei, l1Wei: 0n, totalWei: withBuffer(l2Wei), feeModel: "execution-only" };
}

/** Total wei for one reference tx (+10% buffer). */
export async function estimateTxFunding(params: {
  client: PublicClient;
  chainId: number;
  to: Address;
  data: Hex;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  nonce?: number;
}): Promise<bigint> {
  const breakdown = await estimateTxFundingBreakdown(params);
  return breakdown.totalWei;
}
