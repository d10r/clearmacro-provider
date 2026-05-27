import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../src/config/registry.js";
import {
  sampleRelayerSignerBalances,
  startRelayerSignerBalanceSampler,
} from "../../src/chain/relayerBalanceSampler.js";
import { createMetrics } from "../../src/metrics/metrics.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeRegistry(rpcUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "balance-sampler-"));
  const registryPath = join(dir, "provider.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: [rpcUrl],
          macroPolicy: {
            mode: "allowlist",
            allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
          },
        },
      ],
    }),
  );
  const registry = loadRegistry(registryPath);
  registry.relayerIdByChainId.set(1, "relayer-main");
  return registry;
}

function stubRpcFetch(result: string | "error"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (result === "error") {
        return new Response("rpc down", { status: 500 });
      }
      const payload = JSON.parse(String(init?.body)) as { id: number | string | null };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), { status: 200 });
    }),
  );
}

function metricValue(metricsText: string, name: string, chainId: string): number | undefined {
  const line = metricsText
    .split("\n")
    .find((l) => l.startsWith(`${name}{chain_id="${chainId}"`));
  if (!line) {
    return undefined;
  }
  const value = Number(line.split(" ").at(-1));
  return Number.isFinite(value) ? value : undefined;
}

const relayerClient = {
  getRelayer: async () => ({
    address: "0x00000000000000000000000000000000000000aa",
    paused: false,
    system_disabled: false,
  }),
} as never;

describe("sampleRelayerSignerBalances", () => {
  it("sets native balance, probe success, and timestamp on successful sample", async () => {
    stubRpcFetch("0xde0b6b3a7640000");

    const metrics = createMetrics();
    const before = Math.floor(Date.now() / 1000);

    await sampleRelayerSignerBalances({
      registry: makeRegistry("http://rpc.test"),
      relayerClient,
      metrics,
    });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBe(1);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1")).toBe(1);
    const ts = metricValue(text, "clearmacro_relayer_signer_balance_last_update_timestamp_seconds", "1");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it("sets probe failure without clearing last good balance on RPC error", async () => {
    const metrics = createMetrics();
    const registry = makeRegistry("http://rpc.test");

    stubRpcFetch("0xde0b6b3a7640000");
    await sampleRelayerSignerBalances({ registry, relayerClient, metrics });

    stubRpcFetch("error");
    await sampleRelayerSignerBalances({ registry, relayerClient, metrics });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBe(1);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1")).toBe(0);
  });

  it("marks probe failure when relayer is not bound", async () => {
    const metrics = createMetrics();
    const registry = makeRegistry("http://rpc.test");
    registry.relayerIdByChainId.delete(1);

    await sampleRelayerSignerBalances({
      registry,
      relayerClient: { getRelayer: async () => ({}) } as never,
      metrics,
    });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1")).toBe(0);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBeUndefined();
  });
});

describe("startRelayerSignerBalanceSampler", () => {
  it("skips overlapping sampleOnce while a sample is in flight", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let getRelayerCalls = 0;
    const gatedRelayerClient = {
      getRelayer: async () => {
        getRelayerCalls++;
        await gate;
        return {
          address: "0x00000000000000000000000000000000000000aa",
          paused: false,
          system_disabled: false,
        };
      },
    } as never;

    stubRpcFetch("0xde0b6b3a7640000");

    const metrics = createMetrics();
    const { sampleOnce, stop } = startRelayerSignerBalanceSampler({
      registry: makeRegistry("http://rpc.test"),
      relayerClient: gatedRelayerClient,
      metrics,
      intervalMs: 3_600_000,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    await vi.waitFor(() => expect(getRelayerCalls).toBe(1));

    await sampleOnce();
    await sampleOnce();
    expect(getRelayerCalls).toBe(1);

    releaseGate();
    await vi.waitFor(async () => {
      const text = await metrics.registry.metrics();
      return metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1") === 1;
    });
    // Let sampleOnce() finally clear tickInFlight (probe is set before finally runs).
    await new Promise((resolve) => setTimeout(resolve, 0));

    await sampleOnce();
    expect(getRelayerCalls).toBe(2);

    stop();
  });

  it("stop() prevents interval-driven samples", async () => {
    vi.useFakeTimers();
    stubRpcFetch("0xde0b6b3a7640000");

    let getRelayerCalls = 0;
    const relayerClient = {
      getRelayer: async () => {
        getRelayerCalls++;
        return {
          address: "0x00000000000000000000000000000000000000aa",
          paused: false,
          system_disabled: false,
        };
      },
    } as never;

    const { stop } = startRelayerSignerBalanceSampler({
      registry: makeRegistry("http://rpc.test"),
      relayerClient,
      metrics: createMetrics(),
      intervalMs: 1000,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    await vi.waitFor(() => expect(getRelayerCalls).toBe(1));

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getRelayerCalls).toBe(1);
  });
});
