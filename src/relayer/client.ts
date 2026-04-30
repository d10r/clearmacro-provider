export type OzEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
};

export type OzTransaction = {
  id: string;
  hash: string | null;
  status: string;
  status_reason: string | null;
  created_at: string;
  sent_at: string | null;
  mined_at?: string | null;
  confirmed_at: string | null;
  gas_price: string | null;
  gas_limit: number | null;
  nonce: number | null;
  value: string;
  from: string;
  to: string;
  relayer_id: string;
  data: string;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  receipt?: {
    transactionHash: string;
    blockNumber: string | number;
    blockHash?: string;
    status: string;
    gasUsed?: string | number;
  } | null;
};

export type RelayerDetails = {
  address: string;
  paused: boolean;
  system_disabled: boolean;
  network?: string | null;
  network_type?: string | null;
};

export type OzNetwork = {
  id: string;
  network?: string;
  name?: string;
  network_type: string;
  required_confirmations: number;
};

function extractRelayerListPayload(data: unknown): Array<{ id: string }> {
  if (Array.isArray(data)) {
    return data.filter((item): item is { id: string } => typeof item === "object" && item !== null && "id" in item && typeof (item as { id: string }).id === "string");
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["items", "relayers", "data", "results"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value.filter(
          (item): item is { id: string } => typeof item === "object" && item !== null && "id" in item && typeof (item as { id: string }).id === "string",
        );
      }
    }
  }
  return [];
}

export class OzRelayerClient {
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
        throw new Error(`Relayer HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async ready(): Promise<boolean> {
    const response = await this.call<{ ready: boolean }>("/api/v1/ready", { method: "GET" });
    return response.ready === true;
  }

  /**
   * Lists relayer ids visible to this API key (paginated best-effort).
   */
  async listRelayerIds(): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let page = 1;
    const limit = 50;
    while (true) {
      const envelope = await this.call<OzEnvelope<unknown>>(`/api/v1/relayers?page=${page}&limit=${limit}`, { method: "GET" });
      if (!envelope.success || envelope.data === null || envelope.data === undefined) {
        break;
      }
      const batch = extractRelayerListPayload(envelope.data);
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

  async getRelayer(ozRelayerId: string): Promise<RelayerDetails> {
    const envelope = await this.call<OzEnvelope<RelayerDetails>>(`/api/v1/relayers/${ozRelayerId}`, { method: "GET" });
    if (!envelope.success || !envelope.data) {
      throw new Error(`Relayer details unavailable: ${envelope.error ?? "unknown error"}`);
    }
    return envelope.data;
  }

  async getNetwork(networkType: string, network: string): Promise<OzNetwork> {
    const envelope = await this.call<OzEnvelope<OzNetwork>>(`/api/v1/networks/${networkType}:${network}`, { method: "GET" });
    if (!envelope.success || !envelope.data) {
      throw new Error(`Relayer network unavailable: ${envelope.error ?? "unknown error"}`);
    }
    return envelope.data;
  }

  async submitTransaction(
    ozRelayerId: string,
    payload: { to: string; value: string; data: string; speed: "fast" },
  ): Promise<OzTransaction> {
    const envelope = await this.call<OzEnvelope<OzTransaction>>(`/api/v1/relayers/${ozRelayerId}/transactions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!envelope.success || !envelope.data) {
      throw new Error(`Relayer submit failed: ${envelope.error ?? "unknown error"}`);
    }
    return envelope.data;
  }

  async getTransaction(ozRelayerId: string, transactionId: string): Promise<OzTransaction> {
    const envelope = await this.call<OzEnvelope<OzTransaction>>(
      `/api/v1/relayers/${ozRelayerId}/transactions/${transactionId}`,
      { method: "GET" },
    );
    if (!envelope.success || !envelope.data) {
      throw new Error(`Relayer transaction lookup failed: ${envelope.error ?? "unknown error"}`);
    }
    return envelope.data;
  }
}
