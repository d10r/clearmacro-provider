/**
 * OpenZeppelin Relayer admin API (network/relayer CRUD) for ops scripts.
 * Runtime app code uses src/relayer/client.ts for relay operations only.
 */
import { OzRelayerHttpError, OzRelayerRateLimitError } from "../../src/relayer/errors.js";
import type { OzEnvelope, OzNetwork, RelayerDetails } from "../../src/relayer/client.js";

export type { OzRelayerHttpError, OzRelayerRateLimitError };

export type OzNetworkRecord = {
  id: string;
  network?: string;
  chain_id?: number;
  network_type?: string;
  rpc_urls?: Array<string | { url: string; weight?: number }>;
  required_confirmations?: number | null;
  is_testnet?: boolean;
  symbol?: string;
  average_blocktime_ms?: number;
};

export type CreateEvmNetworkPayload = {
  network: string;
  type: "evm";
  chain_id: number;
  is_testnet: boolean;
  required_confirmations: number;
  average_blocktime_ms: number;
  symbol: string;
  rpc_urls: string[];
};

export type CreateRelayerPayload = {
  id: string;
  name: string;
  network: string;
  network_type: "evm";
  signer_id: string;
  paused?: boolean;
  policies?: { min_balance: number };
};

export type UpdateRelayerPayload = {
  paused?: boolean;
  name?: string;
};

function extractListPayload(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["items", "networks", "relayers", "data", "results"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return [];
}

function normalizeRpcUrls(
  raw: OzNetworkRecord["rpc_urls"],
): { url: string; weight: number }[] | undefined {
  if (!raw || !Array.isArray(raw)) {
    return undefined;
  }
  return raw.map((entry, index) => {
    if (typeof entry === "string") {
      return { url: entry, weight: index === 0 ? 100 : 50 };
    }
    return {
      url: entry.url,
      weight: entry.weight ?? (index === 0 ? 100 : 50),
    };
  });
}

export class OzAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const bodyText = await response.text();
        const snippet = bodyText.length > 400 ? `${bodyText.slice(0, 400)}…` : bodyText;
        if (response.status === 429) {
          throw new OzRelayerRateLimitError(
            snippet ? `Relayer HTTP 429: ${snippet}` : "Relayer HTTP 429",
            429,
            path,
          );
        }
        throw new OzRelayerHttpError(
          snippet ? `Relayer HTTP ${response.status}: ${snippet}` : `Relayer HTTP ${response.status}`,
          response.status,
          path,
        );
      }
      if (response.status === 204) {
        return undefined as T;
      }
      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async callEnvelope<T>(path: string, init?: RequestInit): Promise<T> {
    const envelope = await this.call<OzEnvelope<T>>(path, init);
    if (!envelope.success || envelope.data === null || envelope.data === undefined) {
      throw new Error(`OZ API ${path} failed: ${envelope.error ?? "unknown error"}`);
    }
    return envelope.data;
  }

  async listNetworks(): Promise<OzNetworkRecord[]> {
    const envelope = await this.call<OzEnvelope<unknown>>("/api/v1/networks", { method: "GET" });
    if (!envelope.success) {
      throw new Error(`OZ list networks failed: ${envelope.error ?? "unknown error"}`);
    }
    const items = extractListPayload(envelope.data);
    return items.filter((item): item is OzNetworkRecord => typeof item === "object" && item !== null) as OzNetworkRecord[];
  }

  async getNetwork(networkApiId: string): Promise<OzNetworkRecord> {
    const data = await this.callEnvelope<OzNetworkRecord>(`/api/v1/networks/${encodeURIComponent(networkApiId)}`, {
      method: "GET",
    });
    return { ...data, id: data.id ?? networkApiId };
  }

  async createNetwork(payload: CreateEvmNetworkPayload): Promise<OzNetworkRecord> {
    const networkApiId = `evm:${payload.network}`;
    return this.callEnvelope<OzNetworkRecord>("/api/v1/networks", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        id: networkApiId,
      }),
    });
  }

  async updateNetworkRpcUrls(
    networkApiId: string,
    rpcUrls: { url: string; weight: number }[],
  ): Promise<OzNetworkRecord> {
    return this.callEnvelope<OzNetworkRecord>(`/api/v1/networks/${encodeURIComponent(networkApiId)}`, {
      method: "PATCH",
      body: JSON.stringify({ rpc_urls: rpcUrls }),
    });
  }

  async listRelayerIds(): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let page = 1;
    const limit = 50;
    while (true) {
      const envelope = await this.call<OzEnvelope<unknown>>(`/api/v1/relayers?page=${page}&limit=${limit}`, {
        method: "GET",
      });
      if (!envelope.success || envelope.data === null || envelope.data === undefined) {
        break;
      }
      const batch = extractListPayload(envelope.data).filter(
        (item): item is { id: string } =>
          typeof item === "object" && item !== null && "id" in item && typeof (item as { id: string }).id === "string",
      );
      if (batch.length === 0) {
        break;
      }
      for (const item of batch) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          ids.push(item.id);
        }
      }
      if (batch.length < limit) {
        break;
      }
      page += 1;
    }
    return ids;
  }

  async getRelayer(relayerId: string): Promise<RelayerDetails & { id?: string; name?: string }> {
    const data = await this.callEnvelope<RelayerDetails & { id?: string; name?: string }>(
      `/api/v1/relayers/${encodeURIComponent(relayerId)}`,
      { method: "GET" },
    );
    return data;
  }

  async createRelayer(payload: CreateRelayerPayload): Promise<RelayerDetails & { id: string }> {
    return this.callEnvelope<RelayerDetails & { id: string }>("/api/v1/relayers", {
      method: "POST",
      body: JSON.stringify({
        id: payload.id,
        name: payload.name,
        network: payload.network,
        network_type: payload.network_type,
        signer_id: payload.signer_id,
        paused: payload.paused ?? false,
        policies: payload.policies,
      }),
    });
  }

  async updateRelayer(relayerId: string, payload: UpdateRelayerPayload): Promise<RelayerDetails & { id: string }> {
    return this.callEnvelope<RelayerDetails & { id: string }>(`/api/v1/relayers/${encodeURIComponent(relayerId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  /** Best-effort chain id from network record (API id or fields). */
  static parseChainIdFromNetworkRecord(net: OzNetworkRecord): number | null {
    if (typeof net.chain_id === "number" && Number.isInteger(net.chain_id) && net.chain_id >= 1) {
      return net.chain_id;
    }
    const id = net.id ?? "";
    const eip155 = /^eip155:(\d+)$/i.exec(id);
    if (eip155) {
      return Number(eip155[1]);
    }
    const evmNumeric = /^evm:(\d+)$/i.exec(id);
    if (evmNumeric) {
      return Number(evmNumeric[1]);
    }
    return null;
  }

  static networkRecordRpcUrls(net: OzNetworkRecord): string[] {
    const weighted = normalizeRpcUrls(net.rpc_urls);
    return weighted?.map((w) => w.url) ?? [];
  }
}

/** Thin wrapper matching runtime OzRelayerClient network shape for bind validation. */
export async function getNetworkAsOzNetwork(
  client: OzAdminClient,
  networkType: string,
  networkSlug: string,
): Promise<OzNetwork> {
  const rec = await client.getNetwork(`${networkType}:${networkSlug}`);
  const out: OzNetwork = {
    id: rec.id ?? `${networkType}:${networkSlug}`,
    network: rec.network ?? networkSlug,
    network_type: rec.network_type ?? networkType,
    required_confirmations: rec.required_confirmations ?? null,
  };
  if (rec.chain_id !== undefined) {
    out.chain_id = rec.chain_id;
  }
  return out;
}
