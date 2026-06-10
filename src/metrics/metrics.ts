import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export type AppMetrics = ReturnType<typeof createMetrics>;

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requestCounter = new Counter({
    name: "clearmacro_requests_total",
    help: "Total relay requests by chain, kind, and result",
    labelNames: ["chain_id", "kind", "result"] as const,
    registers: [registry],
  });

  const validationFailureCounter = new Counter({
    name: "clearmacro_validation_failures_total",
    help: "Validation failures by error code",
    labelNames: ["code"] as const,
    registers: [registry],
  });

  const relayerSubmissionCounter = new Counter({
    name: "clearmacro_relayer_submission_total",
    help: "Relayer submission outcomes",
    labelNames: ["relayer_id", "outcome"] as const,
    registers: [registry],
  });

  const relayerPollLatency = new Histogram({
    name: "clearmacro_relayer_poll_duration_seconds",
    help: "Relayer status poll latency",
    labelNames: ["relayer_id"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const readinessGauge = new Gauge({
    name: "clearmacro_readiness",
    help: "Readiness component state",
    labelNames: ["component", "target"] as const,
    registers: [registry],
  });

  const relayerSignerBalanceNative = new Gauge({
    name: "clearmacro_relayer_signer_balance_native",
    help: "Latest sampled native-token balance of the bound OpenZeppelin Relayer signer",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const relayerSignerBalanceProbeSuccess = new Gauge({
    name: "clearmacro_relayer_signer_balance_probe_success",
    help: "1 when the latest balance sample for this chain succeeded, 0 otherwise",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const relayerSignerBalanceLastUpdateTimestampSeconds = new Gauge({
    name: "clearmacro_relayer_signer_balance_last_update_timestamp_seconds",
    help: "Unix timestamp (seconds) of the last successful balance sample for this chain",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  return {
    registry,
    requestCounter,
    validationFailureCounter,
    relayerSubmissionCounter,
    relayerPollLatency,
    readinessGauge,
    relayerSignerBalanceNative,
    relayerSignerBalanceProbeSuccess,
    relayerSignerBalanceLastUpdateTimestampSeconds,
  };
}
