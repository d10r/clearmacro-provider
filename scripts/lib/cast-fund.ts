import { spawnSync } from "node:child_process";
import type { Address, Hash } from "viem";
import { applyKeystorePasswordEnv, keystoreSpawnEnv } from "./keystore-env.js";

function parseTxHash(output: string): Hash {
  const jsonMatch = output.match(/"transactionHash"\s*:\s*"(0x[a-fA-F0-9]{64})"/i);
  if (jsonMatch) return jsonMatch[1] as Hash;
  const lineMatch = output.match(/transactionHash\s+(0x[a-fA-F0-9]{64})/i);
  if (lineMatch) return lineMatch[1] as Hash;
  throw new Error(`could not parse transactionHash from cast output: ${output.trim().slice(0, 200) || "(empty)"}`);
}

function runCast(args: string[]): string {
  applyKeystorePasswordEnv();
  const r = spawnSync("cast", args, { encoding: "utf-8", env: keystoreSpawnEnv(true) });
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0) {
    throw new Error(combined || `cast failed (exit ${r.status ?? 1})`);
  }
  if (combined) console.log(combined);
  return combined;
}

/** Fund an address from a Foundry keystore account. */
export function castFund(rpcUrl: string, walletName: string, to: Address, wei: bigint): Hash {
  console.log(`cast send (fund) → ${to}, value ${wei}`);
  return parseTxHash(
    runCast(["send", to, "--value", wei.toString(), "--rpc-url", rpcUrl, "--account", walletName]),
  );
}
