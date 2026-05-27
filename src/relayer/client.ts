import { OzRelayerHttpError, OzRelayerRateLimitError } from "./errors.js";

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
  /** EVM chain id from OpenZeppelin Relayer when present; preferred over parsing `id`. */
  chain_id?: number;
  network?: string;
  name?: string;
  network_type: string;
  required_confirmations?: number | null;
};

/**
 * RFC 7231 `Retry-After`: delay-seconds (integer) or HTTP-date → milliseconds until retry.
 */
function retryAfterHeaderValueToMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.max(0, when - Date.now());
  }
  return undefined;
}

function headerFirst(headers: Headers, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw !== null && raw.trim().length > 0) {
      return raw;
    }
  }
  return undefined;
}

/**
 * Standard `Retry-After` and actix-governor `x-ratelimit-after` (both use **whole seconds**).
 */
function parseRateLimitHeadersToMs(headers: Headers): number | undefined {
  const retryAfter = headerFirst(headers, ["retry-after", "Retry-After"]);
  if (retryAfter) {
    const ms = retryAfterHeaderValueToMs(retryAfter);
    if (ms !== undefined) {
      return ms;
    }
  }
  const xRateLimitAfter = headerFirst(headers, ["x-ratelimit-after", "X-Ratelimit-After", "X-RateLimit-After"]);
  if (xRateLimitAfter) {
    const seconds = Number.parseFloat(xRateLimitAfter.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(0, Math.ceil(seconds * 1000));
    }
  }
  return undefined;
}

/**
 * OpenZeppelin Relayer API-key governor puts `after` in the JSON body as **whole seconds**
 * (`wait_time_from(..).as_secs()` in `openzeppelin-relayer` `config/rate_limit.rs`).
 */
function parseOpenZeppelinJsonAfterToMs(bodyText: string): number | undefined {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const after = parsed.after;
    if (typeof after === "number" && Number.isFinite(after)) {
      return Math.max(0, Math.ceil(after) * 1000);
    }
    if (typeof after === "string") {
      const t = after.trim();
      if (/^\d+(\.\d+)?$/.test(t)) {
        const seconds = Number.parseFloat(t);
        if (Number.isFinite(seconds) && seconds >= 0) {
          return Math.max(0, Math.ceil(seconds * 1000));
        }
      }
      const when = Date.parse(t);
      if (!Number.isNaN(when)) {
        return Math.max(0, when - Date.now());
      }
    }
  } catch {
    // ignore invalid JSON
  }
  return undefined;
}

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
        const bodyText = await response.text();
        const snippet = bodyText.length > 400 ? `${bodyText.slice(0, 400)}…` : bodyText;
        if (response.status === 429) {
          const retryAfterMs = parseRateLimitHeadersToMs(response.headers) ?? parseOpenZeppelinJsonAfterToMs(bodyText);
          throw new OzRelayerRateLimitError(
            snippet ? `Relayer HTTP 429: ${snippet}` : "Relayer HTTP 429",
            429,
            path,
            retryAfterMs,
          );
        }
        throw new OzRelayerHttpError(
          snippet ? `Relayer HTTP ${response.status}: ${snippet}` : `Relayer HTTP ${response.status}`,
          response.status,
          path,
        );
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
    const limit = 10;
    while (true) {
      const envelope = await this.call<OzEnvelope<unknown>>(`/api/v1/relayers?page=${page}&limit=${limit}`, { method: "GET" });
      if (!envelope.success || envelope.data === null || envelope.data === undefined) {
        break;
      }
      const batch = extractRelayerListPayload(envelope.data);
      if (batch.length === 0) {
        break;
      }
      let added = 0;
      for (const item of batch) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          ids.push(item.id);
          added += 1;
        }
      }
      if (batch.length < limit || added === 0) {
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
