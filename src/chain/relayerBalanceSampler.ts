import type { FastifyBaseLogger } from "fastify";
import { formatEther } from "viem";
import type { LoadedRegistry } from "../config/registry.js";
import type { OzRelayerClient } from "../relayer/client.js";
import type { AppMetrics } from "../metrics/metrics.js";
import { withRpcFallback } from "./readiness.js";
import { chainMetricLabels } from "./protocolMetadata.js";

export type RelayerBalanceSamplerMetrics = Pick<
  AppMetrics,
  | "relayerSignerBalanceNative"
  | "relayerSignerBalanceProbeSuccess"
  | "relayerSignerBalanceLastUpdateTimestampSeconds"
>;

/** Samples native balance for each registry chain's bound OZ relayer signer. */
export async function sampleRelayerSignerBalances(input: {
  registry: LoadedRegistry;
  relayerClient: OzRelayerClient;
  metrics: RelayerBalanceSamplerMetrics;
  logger?: Pick<FastifyBaseLogger, "warn">;
}): Promise<void> {
  for (const chain of input.registry.chainsById.values()) {
    const chainId = chain.chainId;
    const labels = chainMetricLabels(chainId);
    const relayerId = input.registry.relayerIdByChainId.get(chainId);
    if (!relayerId) {
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 0);
      input.logger?.warn({ chainId }, "balance sample: no relayer binding");
      continue;
    }

    let address: `0x${string}`;
    try {
      const relayer = await input.relayerClient.getRelayer(relayerId);
      address = relayer.address as `0x${string}`;
    } catch (error) {
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 0);
      input.logger?.warn({ err: error, chainId }, "balance sample: getRelayer failed");
      continue;
    }

    try {
      const balance = await withRpcFallback(chain, (client) => client.getBalance({ address }));
      input.metrics.relayerSignerBalanceNative.set(labels, Number(formatEther(balance)));
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 1);
      input.metrics.relayerSignerBalanceLastUpdateTimestampSeconds.set(labels, Math.floor(Date.now() / 1000));
    } catch (error) {
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 0);
      input.logger?.warn({ err: error, chainId }, "balance sample: getBalance failed");
    }
  }
}

export function startRelayerSignerBalanceSampler(input: {
  registry: LoadedRegistry;
  relayerClient: OzRelayerClient;
  metrics: RelayerBalanceSamplerMetrics;
  intervalMs: number;
  logger: Pick<FastifyBaseLogger, "warn" | "info">;
}): { stop: () => void; sampleOnce: () => Promise<void> } {
  let stopped = false;
  let tickInFlight = false;

  const sampleOnce = async (): Promise<void> => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      await sampleRelayerSignerBalances({
        registry: input.registry,
        relayerClient: input.relayerClient,
        metrics: input.metrics,
        logger: input.logger,
      });
    } finally {
      tickInFlight = false;
    }
  };

  void sampleOnce();

  const timer = setInterval(() => {
    if (!stopped) {
      void sampleOnce();
    }
  }, input.intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    sampleOnce,
  };
}
