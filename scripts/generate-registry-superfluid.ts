/**
 * Builds a registry JSON from @superfluid-finance/metadata:
 * - One chain per Superfluid network (skips deprecated).
 * - forwarderAddress = Superfluid MacroForwarder (`contractsV1.macroForwarder`).
 * - rpcUrls = metadata `publicRPCs` (replace with private RPC URLs for production load).
 * - macroPolicy.mode = "open" (set allowlists explicitly for production).
 *
 * Usage:
 *   pnpm run registry:gen:superfluid
 *   pnpm run registry:gen:superfluid -- --mainnet-only
 *   pnpm run registry:gen:superfluid -- --out config/registry.superfluid-mainnets.json --mainnet-only
 *
 * Env: REGISTRY_SUPERFLUID_OUT (default config/registry.superfluid-all.json)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "viem";
import metadata from "@superfluid-finance/metadata";
import type { Registry } from "../src/config/schema.js";

function parseArgs(argv: string[]): { out: string; mainnetOnly: boolean } {
  let out = process.env.REGISTRY_SUPERFLUID_OUT ?? "config/registry.superfluid-all.json";
  let mainnetOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mainnet-only") {
      mainnetOnly = true;
    } else if (a === "--out" && argv[i + 1]) {
      out = argv[i + 1] ?? out;
      i++;
    }
  }
  return { out: resolve(out), mainnetOnly };
}

function run(): void {
  const { out, mainnetOnly } = parseArgs(process.argv.slice(2));

  let nets = metadata.networks.filter((n) => !n.isDeprecated);
  if (mainnetOnly) {
    nets = nets.filter((n) => !n.isTestnet);
  }
  nets = [...nets].sort((a, b) => a.chainId - b.chainId);

  const chains: Registry["chains"] = [];

  for (const n of nets) {
    const mf = n.contractsV1.macroForwarder;
    if (!mf) {
      console.warn(`Skipping ${n.name}: no contractsV1.macroForwarder in metadata`);
      continue;
    }
    const rpcs = n.publicRPCs ?? [];
    if (rpcs.length === 0) {
      throw new Error(`Network ${n.name} (chainId ${n.chainId}) has no publicRPCs; cannot build rpcUrls.`);
    }
    chains.push({
      chainId: n.chainId,
      forwarderAddress: getAddress(mf),
      rpcUrls: [...rpcs],
      macroPolicy: { mode: "open" },
    });
  }

  const registry: Registry = { version: 1, chains };
  writeFileSync(out, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  console.log(`Wrote ${out} (${chains.length} chain(s), mainnetOnly=${mainnetOnly})`);
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
