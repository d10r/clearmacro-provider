import metadata from "@superfluid-finance/metadata";

const PAGE_SIZE = 1000;
const MAX_EVENTS = 200_000;

type GraphqlResponse<T> = {
  data?: T;
  errors?: { message?: string }[];
};

type FlowUpdatedPage = {
  flowUpdatedEvents: { id: string }[];
};

export function protocolSubgraphUrl(chainId: number): string | undefined {
  if (chainId === 31337) return undefined;
  const sf = metadata.getNetworkByChainId(chainId);
  if (!sf) return undefined;
  return sf.subgraphV1.hostedEndpoint ?? `https://subgraph-endpoints.superfluid.dev/${sf.name}/protocol-v1`;
}

async function postGraphql<T>(endpoint: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`subgraph HTTP ${response.status}`);
  }
  const payload = (await response.json()) as GraphqlResponse<T>;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message ?? "unknown").join("; "));
  }
  if (!payload.data) {
    throw new Error("subgraph returned no data");
  }
  return payload.data;
}

/** Count CFA `flowUpdatedEvents` since `sinceTimestamp` (unix seconds). */
export async function countFlowUpdatedEventsSince(
  endpoint: string,
  sinceTimestamp: number,
): Promise<{ count: number; capped: boolean }> {
  let total = 0;
  let cursor: string | undefined;
  let capped = false;

  while (total < MAX_EVENTS) {
    const variables: Record<string, unknown> = {
      since: sinceTimestamp.toString(),
      first: PAGE_SIZE,
      cursor: cursor ?? "",
    };
    const query = cursor
      ? `query($since: BigInt!, $first: Int!, $cursor: ID!) {
          flowUpdatedEvents(
            where: { timestamp_gte: $since, id_gt: $cursor }
            first: $first
            orderBy: id
            orderDirection: asc
          ) { id }
        }`
      : `query($since: BigInt!, $first: Int!) {
          flowUpdatedEvents(
            where: { timestamp_gte: $since }
            first: $first
            orderBy: id
            orderDirection: asc
          ) { id }
        }`;

    const page = await postGraphql<FlowUpdatedPage>(endpoint, query, variables);
    const batch = page.flowUpdatedEvents;
    if (batch.length === 0) break;

    total += batch.length;
    cursor = batch[batch.length - 1]?.id;
    if (batch.length < PAGE_SIZE) break;
    if (total >= MAX_EVENTS) {
      capped = true;
      break;
    }
  }

  return { count: total, capped };
}
