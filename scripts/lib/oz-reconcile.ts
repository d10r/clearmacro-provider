/**
 * Diff desired OZ relayer state vs live API and apply reconciling actions.
 */
import { bindRelayersToRegistry } from "../../src/config/relayerDiscovery.js";
import { loadRegistry } from "../../src/config/registry.js";
import { OzRelayerClient } from "../../src/relayer/client.js";
import type { DesiredOzState, OzEvmNetwork } from "./oz-desired-state.js";
import { networkApiId, rpcUrlsToWeightedPayload } from "./oz-desired-state.js";
import { OzAdminClient, type OzNetworkRecord } from "./oz-admin-client.js";

export type ReconcileActionKind =
  | "create_network"
  | "patch_network_rpc"
  | "create_relayer"
  | "patch_relayer_unpause"
  | "patch_relayer_pause"
  | "noop";

export type ReconcileAction = {
  kind: ReconcileActionKind;
  chainId?: number;
  networkApiId?: string;
  relayerId?: string;
  detail: string;
};

export type ReconcilePlan = {
  actions: ReconcileAction[];
  desiredChainIds: Set<number>;
  /** Live relayers mapped by chainId (may be incomplete if network metadata missing). */
  liveRelayersByChainId: Map<number, string[]>;
  /** chainIds in provider but with no live relayer after plan (pre-apply). */
  missingRelayerChainIds: number[];
};

export type BuildPlanOptions = {
  pauseRemovedRelayers: boolean;
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

function findLiveNetworkBySlug(networks: OzNetworkRecord[], slug: string): OzNetworkRecord | undefined {
  const apiId = networkApiId(slug);
  return networks.find((n) => n.id === apiId || n.network === slug);
}

type LiveRelayerOnChain = {
  id: string;
  paused: boolean;
  system_disabled: boolean;
};

async function indexLiveRelayersByChainId(
  client: OzAdminClient,
  liveRelayerIds: string[],
): Promise<Map<number, LiveRelayerOnChain[]>> {
  const liveRelayersByChainId = new Map<number, LiveRelayerOnChain[]>();

  for (const relayerId of liveRelayerIds) {
    let details;
    try {
      details = await client.getRelayer(relayerId);
    } catch {
      continue;
    }
    if (!details.network_type || !details.network) {
      continue;
    }
    let chainId: number | null;
    try {
      const net = await client.getNetwork(`${details.network_type}:${details.network}`);
      chainId = OzAdminClient.parseChainIdFromNetworkRecord(net);
    } catch {
      continue;
    }
    if (chainId === null) {
      continue;
    }
    const list = liveRelayersByChainId.get(chainId) ?? [];
    list.push({
      id: relayerId,
      paused: details.paused,
      system_disabled: details.system_disabled,
    });
    liveRelayersByChainId.set(chainId, list);
  }

  return liveRelayersByChainId;
}

function activeRelayerIds(onChain: LiveRelayerOnChain[]): string[] {
  return onChain.filter((r) => !r.paused && !r.system_disabled).map((r) => r.id);
}

export async function buildReconcilePlan(
  client: OzAdminClient,
  desired: DesiredOzState,
  opts: BuildPlanOptions,
): Promise<ReconcilePlan> {
  const actions: ReconcileAction[] = [];
  const desiredChainIds = new Set(desired.networks.map((n) => n.chain_id));
  const liveNetworks = await client.listNetworks();
  const liveRelayerIds = await client.listRelayerIds();
  const liveRelayersByChainId = await indexLiveRelayersByChainId(client, liveRelayerIds);
  /** Active relayer ids per chain (for pause-removed and plan summary). */
  const liveActiveRelayersByChainId = new Map<number, string[]>();
  for (const [chainId, onChain] of liveRelayersByChainId) {
    liveActiveRelayersByChainId.set(chainId, activeRelayerIds(onChain));
  }

  for (const oz of desired.networks) {
    const chainId = oz.chain_id;
    const apiId = networkApiId(oz.network);
    const liveNet = findLiveNetworkBySlug(liveNetworks, oz.network);
    const desiredRelayerId = desired.relayerIdByChainId.get(chainId)!;

    if (!liveNet) {
      actions.push({
        kind: "create_network",
        chainId,
        networkApiId: apiId,
        detail: `Create network ${apiId} (chainId ${chainId})`,
      });
    } else {
      const liveRpc = OzAdminClient.networkRecordRpcUrls(liveNet);
      if (!rpcUrlsEqual(oz.rpc_urls, liveRpc)) {
        actions.push({
          kind: "patch_network_rpc",
          chainId,
          networkApiId: liveNet.id ?? apiId,
          detail: `Update RPC URLs for ${liveNet.id ?? apiId}`,
        });
      }
    }

    const onChain = liveRelayersByChainId.get(chainId) ?? [];
    const activeIds = activeRelayerIds(onChain);
    const desiredLive = onChain.find((r) => r.id === desiredRelayerId);

    if (desiredLive?.paused && !desiredLive.system_disabled) {
      if (activeIds.length > 0) {
        throw new Error(
          `Unpausing OpenZeppelin relayer ${desiredRelayerId} for chainId ${chainId} would create multiple active relayers: ${activeIds.join(", ")}. Resolve operationally before apply.`,
        );
      }
      actions.push({
        kind: "patch_relayer_unpause",
        chainId,
        relayerId: desiredRelayerId,
        detail: `Unpause relayer ${desiredRelayerId} (chainId ${chainId})`,
      });
    } else if (desiredLive?.system_disabled) {
      throw new Error(
        `OpenZeppelin relayer ${desiredRelayerId} for chainId ${chainId} is system-disabled; resolve operationally before apply.`,
      );
    } else if (activeIds.length === 0) {
      if (!desiredLive) {
        actions.push({
          kind: "create_relayer",
          chainId,
          networkApiId: apiId,
          relayerId: desiredRelayerId,
          detail: `Create relayer ${desiredRelayerId} on ${oz.network}`,
        });
      }
    } else if (activeIds.length > 1) {
      throw new Error(
        `Multiple active OpenZeppelin relayers match chainId ${chainId}: ${activeIds.join(", ")}. Resolve operationally before apply.`,
      );
    } else if (!activeIds.includes(desiredRelayerId)) {
      const existingId = activeIds[0]!;
      actions.push({
        kind: "noop",
        chainId,
        relayerId: existingId,
        detail: `chainId ${chainId} already has active relayer ${existingId} (desired ${desiredRelayerId}); no relayer migration`,
      });
    }
  }

  if (opts.pauseRemovedRelayers) {
    for (const [chainId, relayerIds] of liveActiveRelayersByChainId) {
      if (desiredChainIds.has(chainId)) {
        continue;
      }
      for (const relayerId of relayerIds) {
        actions.push({
          kind: "patch_relayer_pause",
          chainId,
          relayerId,
          detail: `Pause relayer ${relayerId} (chainId ${chainId} removed from provider.json)`,
        });
      }
    }
  }

  const missingRelayerChainIds: number[] = [];
  for (const chainId of desiredChainIds) {
    const activeIds = liveActiveRelayersByChainId.get(chainId) ?? [];
    const willCreate = actions.some((a) => a.chainId === chainId && a.kind === "create_relayer");
    const willUnpause = actions.some((a) => a.chainId === chainId && a.kind === "patch_relayer_unpause");
    if (activeIds.length === 0 && !willCreate && !willUnpause) {
      missingRelayerChainIds.push(chainId);
    }
  }

  const hasMutations = actions.some((a) => a.kind !== "noop");
  if (!hasMutations) {
    actions.push({ kind: "noop", detail: "Live OZ state matches desired provider registry" });
  }

  return { actions, desiredChainIds, liveRelayersByChainId: liveActiveRelayersByChainId, missingRelayerChainIds };
}

export type ApplyPlanOptions = {
  dryRun: boolean;
};

export type ApplyPlanResult = {
  applied: ReconcileAction[];
  skipped: ReconcileAction[];
};

function desiredNetworkForChain(desired: DesiredOzState, chainId: number): OzEvmNetwork {
  const net = desired.networks.find((n) => n.chain_id === chainId);
  if (!net) {
    throw new Error(`Internal: missing desired network for chainId ${chainId}`);
  }
  return net;
}

function desiredRelayerForChain(desired: DesiredOzState, chainId: number) {
  const relayer = desired.relayers.find((r) => desired.relayerIdByChainId.get(chainId) === r.id);
  if (!relayer) {
    throw new Error(`Internal: missing desired relayer for chainId ${chainId}`);
  }
  return relayer;
}

export async function applyReconcilePlan(
  client: OzAdminClient,
  desired: DesiredOzState,
  plan: ReconcilePlan,
  opts: ApplyPlanOptions,
): Promise<ApplyPlanResult> {
  const applied: ReconcileAction[] = [];
  const skipped: ReconcileAction[] = [];

  const order: Record<ReconcileActionKind, number> = {
    create_network: 0,
    patch_network_rpc: 1,
    create_relayer: 2,
    patch_relayer_unpause: 3,
    patch_relayer_pause: 4,
    noop: 5,
  };
  const sorted = [...plan.actions].sort((a, b) => order[a.kind] - order[b.kind]);

  for (const action of sorted) {
    if (action.kind === "noop") {
      skipped.push(action);
      continue;
    }
    if (opts.dryRun) {
      skipped.push(action);
      continue;
    }

    switch (action.kind) {
      case "create_network": {
        const oz = desiredNetworkForChain(desired, action.chainId!);
        await client.createNetwork({
          network: oz.network,
          type: "evm",
          chain_id: oz.chain_id,
          is_testnet: oz.is_testnet,
          required_confirmations: oz.required_confirmations,
          average_blocktime_ms: oz.average_blocktime_ms,
          symbol: oz.symbol,
          rpc_urls: oz.rpc_urls,
        });
        applied.push(action);
        break;
      }
      case "patch_network_rpc": {
        const oz = desiredNetworkForChain(desired, action.chainId!);
        await client.updateNetworkRpcUrls(action.networkApiId!, rpcUrlsToWeightedPayload(oz.rpc_urls));
        applied.push(action);
        break;
      }
      case "create_relayer": {
        const relayer = desiredRelayerForChain(desired, action.chainId!);
        await client.createRelayer({
          id: relayer.id,
          name: relayer.name,
          network: relayer.network,
          network_type: "evm",
          signer_id: relayer.signer_id,
          paused: false,
          policies: relayer.policies,
        });
        applied.push(action);
        break;
      }
      case "patch_relayer_pause": {
        await client.updateRelayer(action.relayerId!, { paused: true });
        applied.push(action);
        break;
      }
      case "patch_relayer_unpause": {
        await client.updateRelayer(action.relayerId!, { paused: false });
        applied.push(action);
        break;
      }
      default:
        skipped.push(action);
    }
  }

  return { applied, skipped };
}

export function formatPlanForConsole(plan: ReconcilePlan): string {
  const lines = ["Reconciliation plan:"];
  for (const action of plan.actions) {
    lines.push(`  [${action.kind}] ${action.detail}`);
  }
  return lines.join("\n");
}

export async function validateRelayerBinding(
  ozRelayerUrl: string,
  ozApiKey: string,
  providerConfigPath: string,
  timeoutMs: number,
): Promise<void> {
  const registry = loadRegistry(providerConfigPath);
  const client = new OzRelayerClient(ozRelayerUrl, ozApiKey, timeoutMs);
  await bindRelayersToRegistry(registry, client);
}

export function planNeedsOzMutation(plan: ReconcilePlan): boolean {
  return plan.actions.some((a) => a.kind !== "noop");
}
