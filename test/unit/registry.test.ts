import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../src/config/registry.js";

describe("loadRegistry", () => {
  it("loads and normalizes registry addresses", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "registry.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            name: "mainnet",
            enabled: true,
            ozRelayerId: "main",
            rpcs: [{ name: "rpc1", url: "http://localhost" }],
            superfluidHost: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            forwarders: {
              clearMacroV1: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
              permit2ClearMacroV1: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
            },
            providers: ["macros.superfluid.eth"],
            macros: [
              {
                address: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
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
            allowedMacros: ["0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"],
          },
        ],
      }),
    );

    const registry = loadRegistry({ registryPath: file, defaultConfirmations: 2 });
    const chain = registry.chainsById.get(1);
    expect(chain?.forwarders.clearMacroV1).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(chain?.confirmations).toBe(2);
  });
});

