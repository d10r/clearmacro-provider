import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseEther,
} from "viem";
import { anvil } from "viem/chains";

export const ROOT = resolve(process.cwd(), "spikes/oz-relayer");
export const RESULTS_DIR = resolve(ROOT, "results");

export const RELAYER_BASE_URL = process.env.RELAYER_BASE_URL ?? "http://localhost:8080";
export const RELAYER_API_KEY =
  process.env.RELAYER_API_KEY ?? "oz-spike-key-32-char-minimum-abcdef";
export const RELAYER_ID = process.env.RELAYER_ID ?? "anvil-relayer";

export const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL ?? "http://localhost:8545";
export const ANVIL_CHAIN_ID = Number(process.env.ANVIL_CHAIN_ID ?? "31337");
export const ANVIL_DEPLOYER_PK =
  process.env.ANVIL_DEPLOYER_PK ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export type JsonObject = Record<string, unknown>;

export type TxResponse = {
  id: string;
  status: string;
  hash?: string;
  nonce?: number;
  status_reason?: string;
  error?: string;
  receipt?: Record<string, unknown>;
};

export type ApiEnvelope<T> = {
  data?: T;
  error?: unknown;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureResultsDir() {
  await mkdir(RESULTS_DIR, { recursive: true });
}

export async function writeResult(name: string, body: unknown) {
  await ensureResultsDir();
  await writeFile(resolve(RESULTS_DIR, name), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export async function relayerFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; data?: T }> {
  const response = await fetch(`${RELAYER_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${RELAYER_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const rawBody = await response.text();
  let body: unknown;
  try {
    body = rawBody ? (JSON.parse(rawBody) as unknown) : {};
  } catch {
    body = { raw: rawBody };
  }

  const envelope = body as ApiEnvelope<T>;
  return { status: response.status, body, data: envelope.data };
}

export async function submitTransaction(payload: JsonObject): Promise<TxResponse> {
  const { status, body, data } = await relayerFetch<TxResponse>(
    `/api/v1/relayers/${RELAYER_ID}/transactions`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (status >= 400 || !data) {
    throw new Error(`submitTransaction failed: ${status} ${JSON.stringify(body)}`);
  }

  return data;
}

export async function getTransaction(txId: string): Promise<TxResponse> {
  const { status, body, data } = await relayerFetch<TxResponse>(
    `/api/v1/relayers/${RELAYER_ID}/transactions/${txId}`,
    { method: "GET" },
  );
  if (status >= 400 || !data) {
    throw new Error(`getTransaction failed: ${status} ${JSON.stringify(body)}`);
  }
  return data;
}

export function isTerminalStatus(status: string): boolean {
  return ["confirmed", "failed", "canceled", "expired", "mined"].includes(status);
}

export async function pollUntilTerminal(
  txIds: string[],
  opts: { timeoutMs?: number; pollMs?: number } = {},
) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_000;
  const startedAt = Date.now();
  const latest: Record<string, TxResponse> = {};

  while (Date.now() - startedAt < timeoutMs) {
    let allTerminal = true;
    for (const txId of txIds) {
      const tx = await getTransaction(txId);
      latest[txId] = tx;
      if (!isTerminalStatus(tx.status)) allTerminal = false;
    }
    if (allTerminal) return latest;
    await sleep(pollMs);
  }

  throw new Error(`Polling timeout after ${timeoutMs}ms for ${txIds.length} txs`);
}

export async function waitForReady() {
  const maxAttempts = Number(process.env.READY_MAX_ATTEMPTS ?? "60");
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const health = await relayerFetch("/api/v1/health");
      const readiness = await relayerFetch("/api/v1/ready");
      if (health.status < 500 && readiness.status < 500) return;
    } catch {
      // keep retrying
    }
    await sleep(1_000);
  }
  throw new Error("Relayer did not become ready in time");
}

export function lifecycleMap(status: string, tx: TxResponse): string {
  if (["pending", "submitted", "sent"].includes(status)) return "pending";
  if (["confirmed", "mined"].includes(status)) return "confirmed";
  if (status === "failed") {
    const reason = `${tx.status_reason ?? ""} ${tx.error ?? ""}`.toLowerCase();
    if (reason.includes("revert") || reason.includes("execution reverted")) return "reverted";
    return "dropped/failed";
  }
  if (status === "canceled" || status === "expired") return "dropped/failed";
  return "submit_failed";
}

export function getAnvilClients() {
  const account = privateKeyToAccount(ANVIL_DEPLOYER_PK as `0x${string}`);
  const transport = http(ANVIL_RPC_URL);
  return {
    account,
    publicClient: createPublicClient({
      chain: { ...anvil, id: ANVIL_CHAIN_ID },
      transport,
    }),
    walletClient: createWalletClient({
      account,
      chain: { ...anvil, id: ANVIL_CHAIN_ID },
      transport,
    }),
  };
}

export async function deployAlwaysRevertContract(): Promise<`0x${string}`> {
  const { publicClient, walletClient, account } = getAnvilClients();
  const initCode = "0x6005600c60003960056000f360006000fd";
  const hash = await walletClient.sendTransaction({
    account,
    data: initCode,
    value: 0n,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("Contract deployment did not return address");
  return receipt.contractAddress;
}

export function encodeSucceed(value: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: [{ type: "function", name: "succeed", stateMutability: "nonpayable", inputs: [{ name: "value", type: "uint256" }], outputs: [] }],
    functionName: "succeed",
    args: [value],
  });
}

export function decodeRevertData(data?: `0x${string}`): string | undefined {
  if (!data || data === "0x") return undefined;
  try {
    const decoded = decodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }],
      data,
    });
    return decoded.errorName;
  } catch {
    return undefined;
  }
}

export const SPIKE_RULES = {
  nonceValidity: [
    "No duplicate nonce across accepted txs",
    "No gap larger than 1 unless at least one tx is terminal failed/canceled/expired",
    "If a replacement occurs, duplicate nonce is allowed only when previous tx with same nonce is terminal non-success",
  ],
  lifecycleStatusMap: {
    pending: ["pending", "sent", "submitted"],
    confirmed: ["mined", "confirmed"],
    reverted: ["failed + status_reason/error contains revert signature"],
    "dropped/failed": ["failed without revert signature", "canceled", "expired"],
    submit_failed: ["HTTP 4xx/5xx on submission"],
  },
  rpcFailoverThreshold: {
    accept: ">= 95% successful submissions when one endpoint is dead and one valid",
    reject: "< 95% success or consistent hard failure without fallback",
  },
};

export async function sendAnvilTransferFromRelayerTargetAddress() {
  return submitTransaction({
    to: "0x000000000000000000000000000000000000dEaD",
    value: parseEther("0.00001").toString(),
    data: "0x",
    gas_limit: 21_000,
    speed: "fast",
  });
}
