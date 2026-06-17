import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { loadRegistry } from "../../src/config/registry.js";
import { validateRelaySignature } from "../../src/chain/readiness.js";
import {
  computePermit2Digest,
  normalizePermit2Request,
} from "../../src/chain/permit2.js";
import { buildPermit2Request } from "../fixtures/relay-fixtures.js";

function makeRegistry(rpcUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "sig-test-"));
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
  return loadRegistry(registryPath);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRpcResponse(method: string, id: number | string | null) {
  if (method === "eth_getCode") {
    return { jsonrpc: "2.0", id, result: "0x6001" };
  }
  if (method === "eth_call") {
    return { jsonrpc: "2.0", id, result: "0x1626ba7e00000000000000000000000000000000000000000000000000000000" };
  }
  return { jsonrpc: "2.0", id, result: null };
}

describe("signature validation", () => {
  it("accepts ERC-1271 contract signature when magic value returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body)) as
          | { method: string; id: number | string | null }
          | Array<{ method: string; id: number | string | null }>;
        if (Array.isArray(parsed)) {
          return new Response(JSON.stringify(parsed.map((entry) => makeRpcResponse(entry.method, entry.id))), { status: 200 });
        }
        return new Response(JSON.stringify(makeRpcResponse(parsed.method, parsed.id)), { status: 200 });
      }),
    );
    const valid = await validateRelaySignature({
      registry: makeRegistry("http://rpc.test"),
      chainId: 1,
      signer: "0x00000000000000000000000000000000000000aa",
      digest: "0x" + "11".repeat(32),
      signature: "0x1234",
    });
    expect(valid).toBe(true);
  });

  it("rejects EOA with invalid signature and no contract code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "eth_getCode") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), { status: 200 });
      }),
    );
    const valid = await validateRelaySignature({
      registry: makeRegistry("http://rpc.test"),
      chainId: 1,
      signer: "0x0000000000000000000000000000000000000001",
      digest: "0x" + "11".repeat(32),
      signature: "0x1234",
    });
    expect(valid).toBe(false);
  });

  it("accepts EOA signature over a Permit2 digest", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20",
    );
    const stored = normalizePermit2Request(buildPermit2Request());
    const digest = computePermit2Digest({
      permit2: stored,
      owner: account.address,
      witness: `0x${"aa".repeat(32)}`,
      witnessTypeString: "witness-type",
      domainSeparator: `0x${"bb".repeat(32)}`,
    });
    const signature = await account.sign({ hash: digest });
    const valid = await validateRelaySignature({
      registry: makeRegistry("http://unused"),
      chainId: 1,
      signer: account.address,
      digest,
      signature,
    });
    expect(valid).toBe(true);
  });

  it("rejects wrong signature over a Permit2 digest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "eth_getCode") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), { status: 200 });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), { status: 200 });
      }),
    );
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20",
    );
    const stored = normalizePermit2Request(buildPermit2Request());
    const digest = computePermit2Digest({
      permit2: stored,
      owner: account.address,
      witness: `0x${"aa".repeat(32)}`,
      witnessTypeString: "witness-type",
      domainSeparator: `0x${"bb".repeat(32)}`,
    });
    const valid = await validateRelaySignature({
      registry: makeRegistry("http://unused"),
      chainId: 1,
      signer: account.address,
      digest,
      signature: "0x1234",
    });
    expect(valid).toBe(false);
  });
});
