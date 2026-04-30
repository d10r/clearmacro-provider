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
            forwarderAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            rpcUrls: ["http://localhost"],
            allowedMacros: [{ domain: "MacroDomain", address: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }],
          },
        ],
      }),
    );

    const registry = loadRegistry(file);
    const chain = registry.chainsById.get(1);
    expect(chain?.forwarderAddress).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(chain?.allowedMacros[0]?.address).toBe("0xdddddddddddddddddddddddddddddddddddddddd");
  });
});
