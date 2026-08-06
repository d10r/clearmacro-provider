import {
  recordActionableFailure,
  type ActionableFailureMetrics,
} from "../metrics/actionableFailures.js";

type TickLogger = {
  error: (obj: { err: unknown }, msg: string) => void;
};

export async function runRelayerAndAuthorizationTicks(input: {
  processRelayerWorkerTick: () => Promise<void>;
  processAuthorizationWorkerTick?: () => Promise<void>;
  metrics: ActionableFailureMetrics;
  log: TickLogger;
}): Promise<void> {
  const relayerPromise = input.processRelayerWorkerTick().catch((error) => {
    input.log.error({ err: error }, "Relayer worker tick failed");
    recordActionableFailure(input.metrics, {
      chainId: "unknown",
      stage: "worker_tick",
      code: "RELAYER_WORKER_TICK_FAILED",
    });
  });
  const authorizationPromise = input.processAuthorizationWorkerTick
    ? input.processAuthorizationWorkerTick().catch((error) => {
        input.log.error({ err: error }, "Authorization worker tick failed");
        recordActionableFailure(input.metrics, {
          chainId: "unknown",
          stage: "worker_tick",
          code: "AUTHORIZATION_WORKER_TICK_FAILED",
        });
      })
    : Promise.resolve();
  await Promise.all([authorizationPromise, relayerPromise]);
}
