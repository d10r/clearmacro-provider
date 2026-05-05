import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../src/config/registry.js";

describe("loadRegistry", () => {
  it("loads and normalizes registry addresses", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            rpcUrls: ["http://localhost"],
            macroPolicy: {
              mode: "allowlist",
              allowedMacros: [{ domain: "MacroDomain", address: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }],
            },
          },
        ],
      }),
    );

    const registry = loadRegistry(file);
    const chain = registry.chainsById.get(1);
    expect(chain?.forwarderAddress).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(chain?.macroPolicy.mode).toBe("allowlist");
    if (chain?.macroPolicy.mode === "allowlist") {
      expect(chain.macroPolicy.allowedMacros[0]?.address).toBe("0xdddddddddddddddddddddddddddddddddddddddd");
    }
  });

  it("rejects registry without rpcUrls", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            macroPolicy: { mode: "open" },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/rpcUrls/);
  });

  it("rejects registry with empty rpcUrls array", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: [],
            macroPolicy: { mode: "open" },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/rpcUrls/);
  });

  it("rejects top-level allowedMacros even when macroPolicy is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: ["http://localhost"],
            allowedMacros: [],
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/top-level allowedMacros/);
  });

  it("rejects allowlist domain that becomes empty after trim normalization", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: ["http://localhost"],
            macroPolicy: {
              mode: "allowlist",
              allowedMacros: [{ domain: "   ", address: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" }],
            },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/domain must not be empty/);
  });

  it("rejects invalid macroPolicy mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: ["http://localhost"],
            macroPolicy: { mode: "invalid" },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/macroPolicy/);
  });

  it("rejects open mode when macroPolicy.allowedMacros is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: ["http://localhost"],
            macroPolicy: {
              mode: "open",
              allowedMacros: [{ domain: "test", address: "0xdddddddddddddddddddddddddddddddddddddddd" }],
            },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/macroPolicy/);
  });

  it("rejects allowlist mode with missing allowedMacros", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: ["http://localhost"],
            macroPolicy: { mode: "allowlist" },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/macroPolicy/);
  });

  it("rejects allowlist mode with empty allowedMacros", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: ["http://localhost"],
            macroPolicy: { mode: "allowlist", allowedMacros: [] },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/macroPolicy/);
  });

  it("rejects duplicate allowlist (domain, address) entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const file = join(dir, "provider.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        chains: [
          {
            chainId: 1,
            forwarderAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            rpcUrls: ["http://localhost"],
            macroPolicy: {
              mode: "allowlist",
              allowedMacros: [
                { domain: "dup", address: "0xdddddddddddddddddddddddddddddddddddddddd" },
                { domain: "dup", address: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" },
              ],
            },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/Duplicate macro allowlist entry/);
  });
});
