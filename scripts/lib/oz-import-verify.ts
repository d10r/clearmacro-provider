/**
 * Direct live OZ import verification: compare provider.json desired state against
 * per-network and per-relayer GET responses (not paginated list endpoints).
 */
import type { DesiredOzState, OzEvmNetwork } from "./oz-desired-state.js";
import { networkApiId } from "./oz-desired-state.js";
import { OzRelayerHttpError } from "../../src/relayer/errors.js";
import { OzAdminClient, type OzNetworkRecord } from "./oz-admin-client.js";
import type { RelayerDetails } from "../../src/relayer/client.js";

export type OzImportMismatch = {
  chainId: number;
  network: string;
  relayerId?: string;
  message: string;
};

function rpcUrlsEqual(desired: readonly string[], live: readonly string[]): boolean {
  if (desired.length !== live.length) {
    return false;
  }
  for (let i = 0; i < desired.length; i++) {
    if (desired[i] !== live[i]) {
      return false;
    }
  }
  return true;
}

function isNotFound(error: unknown): boolean {
  return error instanceof OzRelayerHttpError && error.status === 404;
}

function verifyNetworkFields(oz: OzEvmNetwork, liveNet: OzNetworkRecord): string | null {
  const apiId = networkApiId(oz.network);
  const liveChainId = OzAdminClient.parseChainIdFromNetworkRecord(liveNet);
  if (liveChainId !== oz.chain_id) {
    return `network ${apiId} has chain_id=${liveChainId ?? "unknown"}, expected ${oz.chain_id}`;
  }
  const liveRpc = OzAdminClient.networkRecordRpcUrls(liveNet);
  if (!rpcUrlsEqual(oz.rpc_urls, liveRpc)) {
    return `network ${apiId} RPC URLs differ from provider.json (live: ${liveRpc.join(", ") || "none"})`;
  }
  if (typeof liveNet.is_testnet === "boolean" && liveNet.is_testnet !== oz.is_testnet) {
    return `network ${apiId} is_testnet=${liveNet.is_testnet}, expected ${oz.is_testnet}`;
  }
  if (
    typeof liveNet.required_confirmations === "number" &&
    liveNet.required_confirmations !== oz.required_confirmations
  ) {
    return `network ${apiId} required_confirmations=${liveNet.required_confirmations}, expected ${oz.required_confirmations}`;
  }
  if (liveNet.network && liveNet.network !== oz.network) {
    return `network ${apiId} slug is ${liveNet.network}, expected ${oz.network}`;
  }
  return null;
}

function verifyRelayerFields(
  oz: OzEvmNetwork,
  desiredRelayerId: string,
  liveRelayer: RelayerDetails & { id?: string },
): string | null {
  if (liveRelayer.paused) {
    return `relayer exists but paused=true`;
  }
  if (liveRelayer.system_disabled) {
    return `relayer exists but system_disabled=true`;
  }
  if (liveRelayer.network_type !== "evm") {
    return `relayer network_type=${liveRelayer.network_type ?? "unknown"}, expected evm`;
  }
  if (liveRelayer.network !== oz.network) {
    return `relayer network=${liveRelayer.network ?? "unknown"}, expected ${oz.network}`;
  }
  if (liveRelayer.id && liveRelayer.id !== desiredRelayerId) {
    return `relayer id=${liveRelayer.id}, expected ${desiredRelayerId}`;
  }
  return null;
}

export type VerifyOzImportResult = { ok: true } | { ok: false; mismatches: OzImportMismatch[] };

export async function verifyDesiredOzImport(
  client: OzAdminClient,
  desired: DesiredOzState,
): Promise<VerifyOzImportResult> {
  const mismatches: OzImportMismatch[] = [];

  for (const oz of desired.networks) {
    const chainId = oz.chain_id;
    const apiId = networkApiId(oz.network);
    const desiredRelayerId = desired.relayerIdByChainId.get(chainId)!;

    let liveNet: OzNetworkRecord;
    try {
      liveNet = await client.getNetwork(apiId);
    } catch (error) {
      if (isNotFound(error)) {
        mismatches.push({
          chainId,
          network: oz.network,
          message: `network not found via GET /api/v1/networks/${apiId}`,
        });
        continue;
      }
      throw error;
    }

    const networkMismatch = verifyNetworkFields(oz, liveNet);
    if (networkMismatch) {
      mismatches.push({ chainId, network: oz.network, message: networkMismatch });
    }

    let liveRelayer: RelayerDetails & { id?: string };
    try {
      liveRelayer = await client.getRelayer(desiredRelayerId);
    } catch (error) {
      if (isNotFound(error)) {
        mismatches.push({
          chainId,
          network: oz.network,
          relayerId: desiredRelayerId,
          message: `relayer not found via GET /api/v1/relayers/${desiredRelayerId}`,
        });
        continue;
      }
      throw error;
    }

    const relayerMismatch = verifyRelayerFields(oz, desiredRelayerId, liveRelayer);
    if (relayerMismatch) {
      mismatches.push({
        chainId,
        network: oz.network,
        relayerId: desiredRelayerId,
        message: relayerMismatch,
      });
    }
  }

  if (mismatches.length === 0) {
    return { ok: true };
  }
  return { ok: false, mismatches };
}

export function formatOzImportMismatches(mismatches: readonly OzImportMismatch[]): string {
  const lines = ["OZ import mismatch:"];
  for (const mismatch of mismatches) {
    const relayerPart = mismatch.relayerId ? ` relayer=${mismatch.relayerId}:` : ":";
    lines.push(`- chainId=${mismatch.chainId} network=${mismatch.network}${relayerPart} ${mismatch.message}`);
  }
  return lines.join("\n");
}

export class OzImportVerificationError extends Error {
  readonly mismatches: OzImportMismatch[];

  constructor(mismatches: OzImportMismatch[]) {
    super(formatOzImportMismatches(mismatches));
    this.name = "OzImportVerificationError";
    this.mismatches = mismatches;
  }
}

export async function assertOzImportMatchesDesired(
  client: OzAdminClient,
  desired: DesiredOzState,
): Promise<void> {
  const result = await verifyDesiredOzImport(client, desired);
  if (!result.ok) {
    throw new OzImportVerificationError(result.mismatches);
  }
}
