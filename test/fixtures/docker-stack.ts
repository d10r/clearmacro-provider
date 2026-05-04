import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root: test/fixtures -> ../.. */
export function getRepoRoot(): string {
  return join(__dirname, "..", "..");
}

export function allocateHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr?.port) {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close();
        reject(new Error("Could not allocate port"));
      }
    });
  });
}

export function runDockerCompose(
  repoRoot: string,
  project: string,
  composeArgs: string[],
  extraEnv: Record<string, string>,
): void {
  const r = spawnSync("docker", ["compose", "-p", project, "-f", "compose.e2e.yaml", ...composeArgs], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf-8",
  });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(`docker compose ${composeArgs.join(" ")} failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
}

export function dockerComposeLogs(repoRoot: string, project: string, extraEnv: Record<string, string>): string {
  const r = spawnSync("docker", ["compose", "-p", project, "-f", "compose.e2e.yaml", "logs", "--no-color", "--tail", "200"], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf-8",
  });
  return r.stdout || r.stderr || "(no logs)";
}

export async function waitForJsonRpcChainId(rpcUrl: string, expectedHexChainId: Hex, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const json = (await res.json()) as { result?: string };
      if (json.result === expectedHexChainId) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Anvil RPC not ready at ${rpcUrl} (expected chainId ${expectedHexChainId})`);
}

export async function waitForHttpOk(url: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`HTTP not OK within ${timeoutMs}ms: ${url}`);
}

/** Polls OpenZeppelin Relayer `GET /api/v1/ready` (host port) until `{ ready: true }`. */
export async function waitForOzRelayerReady(ozBase: string, timeoutMs = 90_000): Promise<void> {
  const url = `${ozBase.replace(/\/$/, "")}/api/v1/ready`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      const body = (await res.json()) as { ready?: boolean };
      if (body.ready === true) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`OZ relayer not ready within ${timeoutMs}ms: ${url}`);
}

/** Polls `GET /readyz` until HTTP 200 and `{ ready: true }`. */
export async function waitForReadyz(appBase: string, timeoutMs = 90_000): Promise<void> {
  const url = `${appBase.replace(/\/$/, "")}/readyz`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { ready?: boolean };
        if (body.ready === true) {
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`readyz not ready within ${timeoutMs}ms: ${url}`);
}

export function ensureFixtureArtifact(repoRoot: string): { abi: unknown; bytecode: { object: string } } {
  const forgeDir = join(repoRoot, "test", "fixtures", "contracts");
  const artifactPath = join(forgeDir, "out", "RelayerLikePreflightForwarder.sol", "RelayerLikePreflightForwarder.json");
  if (!existsSync(artifactPath)) {
    const forge = spawnSync("forge", ["build"], { cwd: forgeDir, encoding: "utf-8" });
    if (forge.status !== 0) {
      throw new Error(`forge build failed in ${forgeDir}: ${forge.stderr || forge.stdout}`);
    }
  }
  if (!existsSync(artifactPath)) {
    throw new Error(`Missing fixture artifact after build: ${artifactPath}`);
  }
  return JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown; bytecode: { object: string } };
}

/** Same default private key as scripts/bootstrap-oz-anvil-keystore.ts */
export const RELAYER_SIGNER_PRIVATE_KEY =
  (process.env.RELAYER_SIGNER_PRIVATE_KEY as Hex | undefined) ??
  ("0x59c6995e998f97a5a0044976f6f2f4dc3d6ca4b9f5f3f6f5f78e40d778f0d4d5" as Hex);

export function ensureAnvilKeystore(repoRoot: string, destKeysDir: string): void {
  mkdirSync(destKeysDir, { recursive: true });
  chmodSync(destKeysDir, 0o755);
  const dest = join(destKeysDir, "anvil-relayer.json");
  const src = join(repoRoot, "config", "oz-relayer", "keys", "anvil-relayer.json");
  if (existsSync(src)) {
    copyFileSync(src, dest);
    chmodSync(dest, 0o644);
    return;
  }
  const boot = spawnSync("pnpm", ["run", "oz:bootstrap:anvil"], {
    cwd: repoRoot,
    env: { ...process.env, OZ_KEYSTORE_PASSPHRASE: process.env.OZ_KEYSTORE_PASSPHRASE ?? "change-me" },
    encoding: "utf-8",
  });
  if (boot.status !== 0) {
    throw new Error(`Keystore bootstrap failed: ${boot.stderr || boot.stdout}`);
  }
  if (!existsSync(src)) {
    throw new Error(`Expected keystore at ${src} after bootstrap`);
  }
  copyFileSync(src, dest);
  chmodSync(dest, 0o644);
}

export function writeOzRelayerConfig(stackDir: string): void {
  const config = {
    relayers: [
      {
        id: "anvil-relayer",
        name: "E2E Anvil Relayer",
        network: "localhost-anvil",
        paused: false,
        signer_id: "anvil-signer",
        network_type: "evm",
        policies: { min_balance: 0 },
      },
    ],
    notifications: [],
    signers: [
      {
        id: "anvil-signer",
        type: "local",
        config: {
          path: "./config/keys/anvil-relayer.json",
          passphrase: { type: "env", value: "OZ_KEYSTORE_PASSPHRASE" },
        },
      },
    ],
    networks: "/app/config/networks",
    plugins: [],
  };
  const configPath = join(stackDir, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  chmodSync(configPath, 0o644);

  mkdirSync(join(stackDir, "networks"), { recursive: true });
  chmodSync(join(stackDir, "networks"), 0o755);
  const evm = {
    networks: [
      {
        network: "localhost-anvil",
        type: "evm",
        chain_id: 31337,
        is_testnet: true,
        required_confirmations: 1,
        average_blocktime_ms: 1000,
        symbol: "ETH",
        rpc_urls: ["http://anvil:8545"],
      },
    ],
  };
  const evmPath = join(stackDir, "networks", "evm.json");
  writeFileSync(evmPath, `${JSON.stringify(evm, null, 2)}\n`, "utf8");
  chmodSync(evmPath, 0o644);
}

export function writeProviderRegistry(stackDir: string, forwarderAddress: string): void {
  const macro = "0x00000000000000000000000000000000000000aa";
  const registry = {
    version: 1,
    chains: [
      {
        chainId: 31337,
        forwarderAddress,
        rpcUrls: ["http://anvil:8545"],
        allowedMacros: [{ domain: "e2e", address: macro }],
      },
    ],
  };
  const registryPath = join(stackDir, "registry.json");
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  chmodSync(registryPath, 0o644);
}

const ANVIL_DEFAULT_DEPLOYER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

export async function deployRelayerLikeForwarder(input: {
  rpcUrl: string;
  relayerSignerAddress: Address;
  requestSignerAddress: Address;
  macro: Address;
  payload: Hex;
  signature: Hex;
}): Promise<Address> {
  const chain = {
    id: 31337,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  } as const;
  const repoRoot = getRepoRoot();
  const artifact = ensureFixtureArtifact(repoRoot);
  const deployer = privateKeyToAccount(ANVIL_DEFAULT_DEPLOYER_PK);
  const publicClient = createPublicClient({ chain, transport: http(input.rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(input.rpcUrl), account: deployer });
  const msgValue = 0n;
  const hash = await walletClient.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode.object as Hex,
    args: [
      input.macro,
      input.relayerSignerAddress,
      input.requestSignerAddress,
      keccak256(input.signature),
      msgValue,
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("Deploy receipt missing contractAddress");
  }
  return receipt.contractAddress;
}

export async function fundNativeBalance(rpcUrl: string, address: Address, wei: bigint): Promise<void> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [address, toHex(wei)],
    }),
  });
  const json = (await res.json()) as { error?: { message?: string } };
  if (json.error) {
    throw new Error(`anvil_setBalance failed: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
}

export function digestForRelayerLikeFixture(macro: Address, payload: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "macro", type: "address" },
        { name: "params", type: "bytes" },
      ],
      [macro, payload],
    ),
  );
}

export function makeStackWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cm-stack-e2e-"));
  chmodSync(dir, 0o755);
  return dir;
}
