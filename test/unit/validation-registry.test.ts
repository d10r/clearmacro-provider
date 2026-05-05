import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../src/config/registry.js";
import { assertMacroAllowed } from "../../src/validation/registry.js";

function loadFixtureRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "val-reg-"));
  const path = join(dir, "registry.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: ["http://localhost:8545"],
          macroPolicy: {
            mode: "allowlist",
            allowedMacros: [{ domain: "allowed.domain", address: "0x00000000000000000000000000000000000000aa" }],
          },
        },
      ],
    }),
  );
  return loadRegistry(path);
}

describe("assertMacroAllowed", () => {
  it("allows exact domain and macro address", () => {
    const registry = loadFixtureRegistry();
    expect(
      assertMacroAllowed(registry, {
        chainId: 1,
        domain: "allowed.domain",
        macroAddress: "0x00000000000000000000000000000000000000aa",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects wrong domain", () => {
    const registry = loadFixtureRegistry();
    const r = assertMacroAllowed(registry, {
      chainId: 1,
      domain: "other.domain",
      macroAddress: "0x00000000000000000000000000000000000000aa",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MACRO_NOT_ALLOWED");
    }
  });

  it("rejects wrong macro address", () => {
    const registry = loadFixtureRegistry();
    const r = assertMacroAllowed(registry, {
      chainId: 1,
      domain: "allowed.domain",
      macroAddress: "0x00000000000000000000000000000000000000bb",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown chain", () => {
    const registry = loadFixtureRegistry();
    const r = assertMacroAllowed(registry, {
      chainId: 2,
      domain: "allowed.domain",
      macroAddress: "0x00000000000000000000000000000000000000aa",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("CHAIN_NOT_ALLOWED");
    }
  });

  it("allows every macro in open mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "val-reg-empty-"));
    const path = join(dir, "registry.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0x0000000000000000000000000000000000000001",
            rpcUrls: ["http://localhost:8545"],
            macroPolicy: { mode: "open" },
          },
        ],
      }),
    );
    const registry = loadRegistry(path);
    const r = assertMacroAllowed(registry, {
      chainId: 1,
      domain: "any.domain",
      macroAddress: "0x00000000000000000000000000000000000000aa",
    });
    expect(r).toEqual({ ok: true });
  });
});
