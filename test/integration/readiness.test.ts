import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../src/config/registry.js";
import { evaluateChainReadiness } from "../../src/chain/readiness.js";
import { installMockAgent } from "../fixtures/undici-mocks.js";

let restoreDispatcher: (() => void) | undefined;

afterEach(() => {
  restoreDispatcher?.();
  restoreDispatcher = undefined;
});

function makeRegistry(rpcUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "ready-test-"));
  const registryPath = join(dir, "registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          name: "mainnet",
          enabled: true,
          ozRelayerId: "relayer-main",
          rpcs: [{ name: "rpc1", url: rpcUrl }],
          confirmations: 1,
          superfluidHost: "0x0000000000000000000000000000000000000009",
          forwarders: {
            clearMacroV1: "0x0000000000000000000000000000000000000001",
            permit2ClearMacroV1: "0x0000000000000000000000000000000000000004",
          },
          providers: ["macros.superfluid.eth"],
          macros: [
            {
              address: "0x0000000000000000000000000000000000000002",
              name: "Macro",
              enabled: true,
              supportedKinds: ["clearMacroV1"],
            },
          ],
        },
      ],
      clients: [
        {
          id: "default",
          enabled: true,
          apiTokenHash: null,
          allowedChains: [1],
          allowedProviders: ["macros.superfluid.eth"],
          allowedMacros: ["0x0000000000000000000000000000000000000002"],
        },
      ],
    }),
  );
  return loadRegistry({ registryPath, defaultConfirmations: 1 });
}

describe("chain readiness matrix", () => {
  it("returns PROVIDER_NOT_READY when signer balance is zero", async () => {
    const { mockAgent, restore } = installMockAgent();
    restoreDispatcher = restore;
    mockAgent
      .get("http://rpc.test")
      .intercept({ path: "/", method: "POST" })
      .reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    const readiness = await evaluateChainReadiness({
      registry: makeRegistry("http://rpc.test"),
      chainId: 1,
      relayerClient: {
        ready: async () => true,
        getRelayer: async () => ({
          address: "0x00000000000000000000000000000000000000aa",
          paused: false,
          system_disabled: false,
        }),
      } as never,
    });
    expect(readiness).toEqual({ ready: false, reasonCode: "PROVIDER_NOT_READY" });
  });

  it("returns RELAYER_UNAVAILABLE when relayer is paused or disabled", async () => {
    const registry = makeRegistry("http://does-not-matter");
    const paused = await evaluateChainReadiness({
      registry,
      chainId: 1,
      relayerClient: {
        ready: async () => true,
        getRelayer: async () => ({ address: "0x00000000000000000000000000000000000000aa", paused: true, system_disabled: false }),
      } as never,
    });
    expect(paused).toEqual({ ready: false, reasonCode: "RELAYER_UNAVAILABLE" });

    const disabled = await evaluateChainReadiness({
      registry,
      chainId: 1,
      relayerClient: {
        ready: async () => true,
        getRelayer: async () => ({ address: "0x00000000000000000000000000000000000000aa", paused: false, system_disabled: true }),
      } as never,
    });
    expect(disabled).toEqual({ ready: false, reasonCode: "RELAYER_UNAVAILABLE" });
  });

  it("returns RELAYER_UNAVAILABLE when relayer backend is unreachable", async () => {
    const readiness = await evaluateChainReadiness({
      registry: makeRegistry("http://rpc.test"),
      chainId: 1,
      relayerClient: {
        ready: async () => {
          throw new Error("network down");
        },
        getRelayer: async () => {
          throw new Error("not called");
        },
      } as never,
    });
    expect(readiness).toEqual({ ready: false, reasonCode: "RELAYER_UNAVAILABLE" });
  });

  it("returns PROVIDER_NOT_READY for missing/disabled chain configuration", async () => {
    const registry = makeRegistry("http://rpc.test");
    const missing = await evaluateChainReadiness({
      registry,
      chainId: 999,
      relayerClient: {
        ready: async () => true,
        getRelayer: async () => ({ address: "0x00000000000000000000000000000000000000aa", paused: false, system_disabled: false }),
      } as never,
    });
    expect(missing).toEqual({ ready: false, reasonCode: "PROVIDER_NOT_READY" });
  });

  it("returns CONFIRMATION_MISMATCH when relayer network and registry differ", async () => {
    const readiness = await evaluateChainReadiness({
      registry: makeRegistry("http://rpc.test"),
      chainId: 1,
      relayerClient: {
        ready: async () => true,
        getRelayer: async () => ({
          address: "0x00000000000000000000000000000000000000aa",
          paused: false,
          system_disabled: false,
          network_type: "evm",
          network: "mainnet",
        }),
        getNetwork: async () => ({
          id: "evm:mainnet",
          network_type: "evm",
          required_confirmations: 2,
        }),
      } as never,
    });
    expect(readiness).toEqual({ ready: false, reasonCode: "CONFIRMATION_MISMATCH" });
  });

  it("returns ready true when relayer and rpc checks pass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { id: number | string | null };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0xde0b6b3a7640000" }), { status: 200 });
      }),
    );
    const readiness = await evaluateChainReadiness({
      registry: makeRegistry("http://rpc.test"),
      chainId: 1,
      relayerClient: {
        ready: async () => true,
        getRelayer: async () => ({
          address: "0x00000000000000000000000000000000000000aa",
          paused: false,
          system_disabled: false,
          network_type: "evm",
          network: "mainnet",
        }),
        getNetwork: async () => ({
          id: "evm:mainnet",
          network_type: "evm",
          required_confirmations: 1,
        }),
      } as never,
    });
    expect(readiness).toEqual({ ready: true });
  });

});
