/**
 * Top up the OpenZeppelin Relayer signer on every configured chain.
 *
 * Per-chain runway: `fundingTxCount` from 30d Superfluid subgraph activity (flowUpdatedEvents),
 * scaled vs median, unless provider DB has relay history (preferred). Flat mode: set TARGET_TX_COUNT.
 *
 * Usage (from repo root, with .env and config/provider.json):
 *   SIMULATE=1 pnpm run prod:fund
 *   pnpm run prod:fund
 *
 * Env:
 *   SIMULATE=1
 *   FUNDING_BASE_TX_COUNT     — median-chain runway (default 30)
 *   FUNDING_MIN_TX            — floor per chain (default 10)
 *   FUNDING_MAX_TX            — ceiling per chain (default 500)
 *   FUNDING_ACTIVITY_DAYS     — lookback (default 30)
 *   TARGET_TX_COUNT           — flat mode: same count on every chain (disables activity scoring)
 *   FUNDING_TX_COUNT_<id>     — per-chain override, e.g. FUNDING_TX_COUNT_8453=120
 *   GAS_LIMIT, EST_TX_COST, WALLET_NAME, KEYSTORE_PASSWORD, CHAIN_IDS, MAINNET_ONLY, TESTNET_ONLY
 */
import { existsSync } from "node:fs";
import metadata from "@superfluid-finance/metadata";
import dotenv from "dotenv";
import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import { estimateRelayFundingTarget } from "../src/chain/relayer-funding.js";
import { castFund } from "./lib/cast-fund.js";
import { resolveChainFundingPlan, type ChainActivity } from "./lib/funding-tx-counts.js";
import {
  assertKeystoreUnderOzConfig,
  formatEthFromWei,
  loadProviderConfig,
  readRelayerSignerAddress,
  resolveProdPaths,
} from "./lib/prod-signer.js";

dotenv.config();

type FundStatus = "ok" | "skip" | "fail" | "sim";

function fundStep(label: string): void {
  console.log(`======== ${label} ========`);
}

function fundSkip(reason: string): void {
  console.log(`→ skip: ${reason}`);
}

function fundDone(): void {
  console.log("→ done");
}

function fundStatusLabel(status: FundStatus): string {
  switch (status) {
    case "ok":
      return "ok";
    case "skip":
      return "skip";
    case "fail":
      return "FAIL";
    case "sim":
      return "sim";
    default:
      return status;
  }
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return n;
}

function parseFlatTxCount(): number | undefined {
  const raw = process.env.TARGET_TX_COUNT?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid TARGET_TX_COUNT: ${raw}`);
  }
  return n;
}

function parseBigIntEnv(name: string): bigint | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
}

function parseChainFilter(): Set<number> | undefined {
  const raw = process.env.CHAIN_IDS?.trim();
  if (!raw) return undefined;
  const ids = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new Error(`Invalid CHAIN_IDS: ${raw}`);
  }
  return new Set(ids);
}

function perChainOverride(chainId: number): number | undefined {
  const raw = process.env[`FUNDING_TX_COUNT_${chainId}`]?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid FUNDING_TX_COUNT_${chainId}: ${raw}`);
  }
  return n;
}

function isTestnetChain(chainId: number): boolean {
  if (chainId === 31337) return true;
  const sf = metadata.getNetworkByChainId(chainId);
  return sf?.isTestnet ?? false;
}

function chainLabel(chainId: number): string {
  const sf = metadata.getNetworkByChainId(chainId);
  return sf?.name ?? `chain-${chainId}`;
}

function shouldProcessChain(
  chainId: number,
  chainFilter: Set<number> | undefined,
  mainnetOnly: boolean,
  testnetOnly: boolean,
): boolean {
  if (chainFilter && !chainFilter.has(chainId)) return false;
  if (mainnetOnly && isTestnetChain(chainId)) return false;
  if (testnetOnly && !isTestnetChain(chainId)) return false;
  return true;
}

function printFundingPlan(plan: ChainActivity[], activityDays: number, flatTxCount: number | undefined): void {
  console.log("");
  console.log(`Funding plan (${activityDays}d activity, ${flatTxCount !== undefined ? "flat" : "subgraph/DB"} mode):`);
  console.log("chainId | network | flowEvents | relays | fundingTxCount | source");
  for (const row of plan) {
    const note = row.note ? ` (${row.note})` : "";
    console.log(
      `${row.chainId} | ${chainLabel(row.chainId)} | ${row.flowEvents30d} | ${row.relayExecutions30d} | ${row.fundingTxCount} | ${row.source}${note}`,
    );
  }
  console.log("");
}

async function run(): Promise<void> {
  const simulate = process.env.SIMULATE === "1";
  const mainnetOnly = process.env.MAINNET_ONLY === "1";
  const testnetOnly = process.env.TESTNET_ONLY === "1";
  if (mainnetOnly && testnetOnly) {
    throw new Error("MAINNET_ONLY and TESTNET_ONLY are mutually exclusive");
  }
  const flatTxCount = parseFlatTxCount();
  const activityDays = parsePositiveInt("FUNDING_ACTIVITY_DAYS", 30);
  const baseTxCount = parsePositiveInt("FUNDING_BASE_TX_COUNT", 30);
  const minTxCount = parsePositiveInt("FUNDING_MIN_TX", 10);
  const maxTxCount = parsePositiveInt("FUNDING_MAX_TX", 500);
  const walletName = process.env.WALLET_NAME?.trim() || "sf-ops";
  const minTopUp = parseBigIntEnv("MIN_TOP_UP_WEI") ?? 0n;
  const estOverride = parseBigIntEnv("EST_TX_COST");
  const gasLimitOverride = parseBigIntEnv("GAS_LIMIT");
  const chainFilter = parseChainFilter();
  const passphrase = process.env.OZ_KEYSTORE_PASSPHRASE;
  if (!passphrase) {
    throw new Error("OZ_KEYSTORE_PASSPHRASE is required");
  }

  const { providerConfigPath, keystorePath, ozConfigDir } = resolveProdPaths();
  if (!existsSync(providerConfigPath) || !existsSync(keystorePath)) {
    throw new Error("Missing provider config or relayer keystore; run prod:init first");
  }
  assertKeystoreUnderOzConfig(keystorePath, ozConfigDir);

  const providerConfig = loadProviderConfig(providerConfigPath);
  const defaultFundee = readRelayerSignerAddress(keystorePath, passphrase);
  const fundee = (process.env.FUNDEE_ADDRESS?.trim() ?? defaultFundee) as Address;

  const eligibleChainIds = providerConfig.chains
    .filter((c) => shouldProcessChain(c.chainId, chainFilter, mainnetOnly, testnetOnly))
    .map((c) => c.chainId);

  console.log("Resolving per-chain fundingTxCount from subgraph/DB activity...");
  const plan = await resolveChainFundingPlan({
    chainIds: eligibleChainIds,
    activityDays,
    baseTxCount,
    minTxCount,
    maxTxCount,
    ...(flatTxCount !== undefined ? { flatTxCount } : {}),
    ...(process.env.DATABASE_PATH ? { databasePath: process.env.DATABASE_PATH } : {}),
    perChainOverride,
  });
  const fundingTxByChainId = new Map(plan.map((row) => [row.chainId, row.fundingTxCount]));

  console.log(`Fundee: ${fundee}`);
  console.log(`Funder: Foundry account ${walletName}`);
  printFundingPlan(plan, activityDays, flatTxCount);
  if (simulate) console.log("SIMULATE=1: no transfers");

  const summary: { chainId: number; status: FundStatus }[] = [];

  for (const chain of providerConfig.chains) {
    const label = chainLabel(chain.chainId);
    fundStep(`${label} (chainId=${chain.chainId})`);

    if (!shouldProcessChain(chain.chainId, chainFilter, mainnetOnly, testnetOnly)) {
      fundSkip(chainFilter ? "CHAIN_IDS filter" : mainnetOnly ? "MAINNET_ONLY" : "TESTNET_ONLY");
      summary.push({ chainId: chain.chainId, status: "skip" });
      continue;
    }

    const txCount = fundingTxByChainId.get(chain.chainId) ?? minTxCount;
    console.log(`fundingTxCount=${txCount}`);

    const rpcUrl = chain.rpcUrls[0];
    if (!rpcUrl) {
      fundSkip("no rpcUrls");
      summary.push({ chainId: chain.chainId, status: "skip" });
      continue;
    }

    let estimate;
    try {
      estimate = await estimateRelayFundingTarget({
        rpcUrl,
        chainId: chain.chainId,
        forwarderAddress: chain.forwarderAddress as Address,
        relayerSigner: fundee,
        txCount,
        ...(gasLimitOverride !== undefined ? { gasLimitOverride } : {}),
        ...(estOverride !== undefined ? { perTxCostOverride: estOverride } : {}),
      });
      console.log(
        `reference tx: gas=${estimate.gasLimit} maxFee=${estimate.maxFeePerGas} model=${estimate.feeModel} l2=${estimate.l2Wei} l1=${estimate.l1Wei} perTx=${estimate.perTxWei} target=${estimate.targetWei}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`→ FAIL: estimate failed (${reason})`);
      summary.push({ chainId: chain.chainId, status: "fail" });
      continue;
    }

    const client = createPublicClient({ transport: http(rpcUrl) });
    const balance = await client.getBalance({ address: fundee });
    console.log(
      `balance=${formatEthFromWei(balance)} (${balance} wei) target=${formatEthFromWei(estimate.targetWei)} (${estimate.targetWei} wei)`,
    );

    if (balance >= estimate.targetWei) {
      fundSkip("balance already at or above target");
      summary.push({ chainId: chain.chainId, status: "skip" });
      continue;
    }

    const topUp = estimate.targetWei - balance;
    if (topUp < minTopUp) {
      fundSkip(`top-up ${topUp} wei below MIN_TOP_UP_WEI`);
      summary.push({ chainId: chain.chainId, status: "skip" });
      continue;
    }

    if (simulate) {
      console.log(`→ would fund ${formatEthFromWei(topUp)} (${topUp} wei)`);
      summary.push({ chainId: chain.chainId, status: "sim" });
      continue;
    }

    try {
      const hash = castFund(rpcUrl, walletName, fundee, topUp);
      console.log("tx:", hash);
      fundDone();
      summary.push({ chainId: chain.chainId, status: "ok" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`→ FAIL: ${reason}`);
      summary.push({ chainId: chain.chainId, status: "fail" });
    }
  }

  console.log("");
  console.log("Funding summary:");
  for (const row of summary) {
    console.log(`- chainId=${row.chainId} ${chainLabel(row.chainId)}: ${fundStatusLabel(row.status)}`);
  }

  if (summary.some((r) => r.status === "fail")) {
    process.exitCode = 1;
  }
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
